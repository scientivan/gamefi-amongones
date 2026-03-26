import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import dotenv from "dotenv";
import cors from "cors";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3001;

import { GameEngine, GamePhase } from "./engine/GameEngine";
import { streakService } from "./services/StreakService";
import { voteService } from "./services/VoteService";
import { missionService } from "./services/MissionService";
import { contractClient } from "./services/contractClient";

// Load persisted data
streakService.load();
missionService.load();

// Wire VoteService events → broadcast to clients
voteService.onVoteEvent((tally) => {
  io.to(SIM_GAME_ID).emit("vote_update", tally);
});

// Initialize SINGLE global simulation game
const SIM_GAME_ID = "sim-1";
const game = new GameEngine(
  SIM_GAME_ID,
  // onPhaseChange
  (phase) => {
    io.to(SIM_GAME_ID).emit("phase_change", phase);
    // Start/stop vote polling based on phase
    if (phase === GamePhase.LOBBY) {
      const objId = contractClient.gameId;
      const numId = contractClient.numericGameId;
      if (objId && numId !== null) {
        voteService.startForGame(objId, numId);
      }
    }
    if (phase === GamePhase.ENDED) {
      voteService.stopPolling();
    }
  },
  // onStateUpdate
  (state) => {
    io.to(SIM_GAME_ID).emit("game_state_update", state);
  },
  // onNewMessage
  (msg) => {
    io.to(SIM_GAME_ID).emit("new_message", msg);
  },
  // onGameEnded — update streaks & missions
  async (gameObjectId, winningTeam) => {
    const numericId = contractClient.numericGameId;
    if (numericId === null) return;
    const bettors = await contractClient.getBettorsForGame(numericId);
    if (bettors.length === 0) return;

    const changed = streakService.onGameSettled(gameObjectId, winningTeam, bettors);
    for (const addr of changed) {
      const rec = streakService.getStreak(addr);
      io.to(SIM_GAME_ID).emit("streak_update", rec);
    }

    for (const b of bettors) {
      const won = b.team === winningTeam;
      const streak = streakService.getStreak(b.address).currentStreak;
      missionService.onGameResult(b.address, won, streak);
    }
  },
  // onOddsUpdate
  (odds) => {
    io.to(SIM_GAME_ID).emit("odds_update", odds);
  },
  // onGetVoteModifier
  () => voteService.getCurrentModifier(),
);

// Start the automation immediately
game.startAutomatedLoop();


import { moltbookService } from "./services/MoltbookService";

// ── REST API ──────────────────────────────────────────────────────────────────
app.get("/api/streaks/top", (_req, res) => {
  res.json(streakService.getTop(20));
});

app.get("/api/streaks/:address", (req, res) => {
  res.json(streakService.getStreak(req.params.address));
});

app.get("/api/missions/:address", async (req, res) => {
  // Sync progress from chain events (rate-limited to 60s per address)
  await missionService.syncProgressFromChain(req.params.address);
  const missions = missionService.getMissions(req.params.address);
  // Serialize BigInt reward as string for JSON
  res.json(missions.map(m => ({ ...m, reward: m.reward.toString() })));
});

app.post("/api/missions/:address/claim/:missionId", async (req, res) => {
  try {
    const result = await missionService.claimMission(req.params.address, req.params.missionId);
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Map socket ID to Agent ID (Player ID)
const socketToAgent = new Map<string, string>();

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Auto-join the simulation room (for viewing)
  socket.join(SIM_GAME_ID);

  // Send immediate state
  socket.emit("lobby_update", game.getState());

  // ── Authentication ────────────────────────────────────────────────────────
  socket.on("auth_token", async (token: string) => {
    console.log(`Socket ${socket.id} attempting auth...`);
    const agent = await moltbookService.verifyIdentity(token);

    if (!agent) {
      socket.emit("auth_error", "Invalid identity token");
      return;
    }

    console.log(`Agent authenticated: ${agent.name} (${agent.id})`);

    // 1. Check if agent is already in the game (by name)
    let targetId = agent.id;
    const existingPlayer = Object.values(game.players).find(
      (p) => p.name === agent.name,
    );

    if (existingPlayer) {
      // Claim existing bot
      targetId = existingPlayer.id;
      console.log(`Agent ${agent.name} claiming existing bot ${targetId}`);
    } else {
      // 2. Not in game -> Try to join
      if (game.phase === GamePhase.LOBBY) {
        // addPlayer uses agent.id as key
        game.addPlayer(agent);

        // Check if added successfully
        if (!game.players[agent.id]) {
          socket.emit("auth_error", "Lobby full or join failed");
          return;
        }
        targetId = agent.id;
      } else {
        socket.emit("auth_error", "Game in progress, cannot join late");
        return;
      }
    }

    // 3. Mark as controlled
    if (game.players[targetId]) {
      game.players[targetId].isControlled = true;
      game.map.setControlled(targetId, true);

      socketToAgent.set(socket.id, targetId);
      socket.emit("auth_success", {
        id: targetId,
        name: agent.name,
        role: game.players[targetId].role,
      });
    }
  });

  // ── Game Actions ──────────────────────────────────────────────────────────
  socket.on("action", (data: { type: string; payload: any }) => {
    const agentId = socketToAgent.get(socket.id);
    if (!agentId) {
      // socket.emit("error", "Not authenticated");
      return;
    }

    // Forward to GameEngine
    game.handleAction(agentId, data.type, data.payload);
  });

  // ── Spectator Chat ────────────────────────────────────────────────────────
  socket.on("send_message", (data: { gameId: string; message: string }) => {
    // If agent is authenticated, use their name
    const agentId = socketToAgent.get(socket.id);
    const senderName = agentId ? game.players[agentId]?.name : "Spectator";

    io.to(SIM_GAME_ID).emit("new_message", {
      sender: senderName,
      content: data.message,
      timestamp: Date.now(),
      type: "chat",
    });
  });

  socket.on("disconnect", () => {
    console.log("Client disconnected:", socket.id);

    // Release control?
    const agentId = socketToAgent.get(socket.id);
    if (agentId) {
      console.log(`Agent ${agentId} disconnected, reverting to AI control`);
      socketToAgent.delete(socket.id);
      if (game.players[agentId]) {
        game.players[agentId].isControlled = false;
        game.map.setControlled(agentId, false);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Simulation 'sim-1' started automatically.`);
});
