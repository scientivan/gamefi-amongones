import { MapManager, RoomType } from "./MapManager";
import { MeetingManager } from "./MeetingManager";
import { moltbookService, MoltbookAgent } from "../services/MoltbookService";
import { contractClient } from "../services/contractClient";

export enum GamePhase {
  LOBBY = "LOBBY",
  ACTION = "ACTION",
  MEETING = "MEETING",
  ENDED = "ENDED",
}

export interface Player {
  id: string; // Socket ID or Agent ID
  name: string;
  role: "Crewmate" | "Impostor";
  alive: boolean;
  room: RoomType;
  x: number; // current position in % (0-100)
  y: number;
  isBot: boolean;
  isControlled?: boolean; // If true, this agent is controlled via socket, not AI loop
  color?: string;
  avatar?: string;
  owner?: string; // X handle
  ownerAvatar?: string;
  ownerFollowers?: number;
  karma?: number;
  posts?: string[]; // Recent posts history
}

// ── Task definitions ─────────────────────────────────────────────────────────
// Each task is tied to a room. Crewmates "complete" a task by spending ticks
// in the same room while idle (simulated via taskTicksRemaining countdown).

export interface TaskDef {
  id: string; // unique key, e.g. "wires_cafeteria"
  name: string; // human-readable label
  room: RoomType; // which room the task is located in
}

const TASK_POOL: TaskDef[] = [
  { id: "wires_cafeteria", name: "Fix Wires", room: RoomType.CAFETERIA },
  { id: "upload_nav", name: "Upload Data", room: RoomType.NAVIGATION },
  {
    id: "calibrate_shields",
    name: "Calibrate Shields",
    room: RoomType.SHIELDS,
  },
  { id: "refuel_engine", name: "Refuel Engines", room: RoomType.ENGINE_ROOM },
  { id: "align_medbay", name: "Align Extract", room: RoomType.MEDBAY },
  { id: "route_admin", name: "Route Admin", room: RoomType.ADMIN },
  { id: "repair_storage", name: "Repair Panel", room: RoomType.STORAGE },
  { id: "navigate_bridge", name: "Set Course", room: RoomType.BRIDGE },
  {
    id: "clean_weapons_top",
    name: "Clean Weapons",
    room: RoomType.WEAPONS_TOP,
  },
  {
    id: "clean_weapons_bot",
    name: "Clean Weapons",
    room: RoomType.WEAPONS_BOTTOM,
  },
];

// How many ACTION ticks a crewmate must spend in the task's room to complete it.
const TASK_DURATION_TICKS = 4;

// ── Sabotage definitions ─────────────────────────────────────────────────────
// An impostor can trigger a critical sabotage once per ACTION phase.
// If the countdown reaches 0 before a crewmate repairs it, impostors win.

export interface SabotageTarget {
  id: string;
  name: string;
  room: RoomType; // room where crewmates must go to repair
  timer: number; // seconds countdown
}

const SABOTAGE_OPTIONS: SabotageTarget[] = [
  {
    id: "reactor",
    name: "Reactor Meltdown",
    room: RoomType.ENGINE_ROOM,
    timer: 45,
  },
  { id: "oxygen", name: "O2 Depleted", room: RoomType.CAFETERIA, timer: 40 },
  {
    id: "comms",
    name: "Comms Sabotaged",
    room: RoomType.NAVIGATION,
    timer: 50,
  },
  { id: "lights", name: "Lights Sabotaged", room: RoomType.SHIELDS, timer: 55 },
];

// How many ticks after game start before an impostor is allowed to sabotage (grace period).
const SABOTAGE_COOLDOWN_TICKS = 45; // 45s grace → sabotage available earlier for impostor balance

// How many ticks a crewmate must spend in the repair room to fix sabotage.
const REPAIR_DURATION_TICKS = 10; // harder to repair — balance for crewmates

export interface OddsData {
  crewPool: number;
  impPool: number;
  crewOdds: string;
  impOdds: string;
  total: number;
  timeLeft: number;
}

export class GameEngine {
  public id: string;
  public phase: GamePhase;
  public map: MapManager;
  public meeting: MeetingManager;
  public players: Record<string, Player> = {};

  // Meeting Context
  public meetingContext: {
    reporter?: string;
    bodyFound?: string;
    votesReceived: Record<string, string>; // voterId -> targetId
  } = { votesReceived: {} };

  // End-game result — set by endGame(), cleared on reset
  public winner: string | null = null;

  // ── Task system state ──────────────────────────────────────────────────────
  // Per-crewmate assigned tasks. Key = playerId, value = array of tasks with completion state.
  private crewTasks: Record<
    string,
    { task: TaskDef; completed: boolean; ticksRemaining: number }[]
  > = {};

  // ── Sabotage state ─────────────────────────────────────────────────────────
  private activeSabotage: SabotageTarget | null = null; // null when no sabotage is active
  private sabotageRepairTicks: number = 0; // ticks a crewmate has spent in the repair room
  private sabotageTriggered: boolean = false; // true once sabotage has been triggered this ACTION phase
  private sabotageGraceTicks: number = 0; // ticks remaining before sabotage becomes available

  // Automation
  private loopInterval: NodeJS.Timeout | null = null;
  private movementInterval: NodeJS.Timeout | null = null;
  private commentStreamInterval: NodeJS.Timeout | null = null;
  public phaseTimer: number = 0; // seconds remaining in current phase
  private readonly LOBBY_TIME = 180; // 3 minute lobby
  private readonly GAME_TIME = 300; // 5 minutes
  private readonly BET_LOCK_TIME = 120; // lock bets 2 min into ACTION (when timer = GAME_TIME - 120 = 120s left)
  private readonly MEETING_TIME = 15; // Fast meetings for sim
  private readonly RESET_TIME = 20;
  private readonly MAX_PLAYERS = 10;
  private readonly SPAWN_INTERVAL = 15; // spawn 1 agent every 15s -> all 10 in ~150s (slow drip)
  private spawnCooldown: number = 0; // countdown until next spawn is allowed

  // Per-impostor kill cooldown (key = playerId, value = ticks remaining)
  private killCooldowns: Record<string, number> = {};

  // ── Per-game randomised parameters (re-rolled each startGame) ─────────────
  private gameKillCooldown: number = 25;    // ticks between kills  [15..45]
  private gameKillChance: number = 0.15;    // chance per tick       [0.08..0.28]
  private gameMeetingChance: number = 0.30; // body-found chance     [0.15..0.50]
  private gameVoteAccuracy: number = 0.30;  // crewmate vote accuracy[0.18..0.45]
  private gameSabotageChance: number = 0.03;// sabotage chance/tick  [0.02..0.06]
  private meetingChatCooldown: number = 0; // ticks until next meeting message is allowed
  private meetingChatCount: number = 0; // how many messages sent this meeting
  private savedActionTimer: number = 0; // ACTION time remaining before a meeting interruption
  private bettingLocked: boolean = false; // true once bets are locked mid-ACTION

  private onPhaseChange: (phase: GamePhase) => void;
  private onStateUpdate: (state: any) => void;
  private onNewMessage: (msg: {
    sender: string;
    content: string;
    timestamp: number;
    type: "chat" | "meeting";
  }) => void;
  private onGameEnded?: (gameObjectId: string, winningTeam: number) => void;
  private onOddsUpdate?: (odds: OddsData) => void;
  private onGetVoteModifier?: () => number;

  // Odds polling state
  private oddsTick = 0;
  private oddsPolling = false;

  constructor(
    id: string,
    onPhaseChange: (phase: GamePhase) => void,
    onStateUpdate: (state: any) => void,
    onNewMessage: (msg: {
      sender: string;
      content: string;
      timestamp: number;
      type: "chat" | "meeting";
    }) => void,
    onGameEnded?: (gameObjectId: string, winningTeam: number) => void,
    onOddsUpdate?: (odds: OddsData) => void,
    onGetVoteModifier?: () => number,
  ) {
    this.id = id;
    this.phase = GamePhase.LOBBY;
    this.map = new MapManager();
    this.meeting = new MeetingManager();
    this.onPhaseChange = onPhaseChange;
    this.onStateUpdate = onStateUpdate;
    this.onNewMessage = onNewMessage;
    this.onGameEnded = onGameEnded;
    this.onOddsUpdate = onOddsUpdate;
    this.onGetVoteModifier = onGetVoteModifier;

    // Start Moltbook polling (for agent spawning)
    moltbookService.startPolling();

    // Fetch real comments once, then start streaming them every 2s
    moltbookService.fetchComments().then(() => {
      this.commentStreamInterval = setInterval(() => {
        const comment = moltbookService.getNextComment();
        if (comment) {
          this.onNewMessage({
            sender: comment.author,
            content: comment.content,
            timestamp: Date.now(),
            type: "chat",
          });
        }
      }, 2000);
    });
  }

  public startAutomatedLoop() {
    if (this.loopInterval) return;

    console.log("🦞 GameEngine: Starting Automated Simulation Loop");
    this.phase = GamePhase.LOBBY;
    this.phaseTimer = this.LOBBY_TIME;

    // Seed on-chain game for the first lobby
    contractClient
      .seedPool()
      .catch((err) =>
        console.error("[ContractClient] seedPool on initial start failed:", err),
      );

    // Game-logic tick every 1 second (phase timer, kills, tasks, sabotage, voting)
    this.loopInterval = setInterval(() => {
      this.updateLoop();
    }, 1000);

    // Movement + state-broadcast tick every 100ms (10× per second → very smooth movement)
    this.movementInterval = setInterval(() => {
      this.movementTick();
    }, 100);
  }

  public stopLoop() {
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    if (this.movementInterval) {
      clearInterval(this.movementInterval);
      this.movementInterval = null;
    }
    if (this.commentStreamInterval) {
      clearInterval(this.commentStreamInterval);
      this.commentStreamInterval = null;
    }
    moltbookService.stopPolling();
  }

  private updateLoop() {
    this.phaseTimer--;

    // 1. PHASE MANAGEMENT
    if (this.phaseTimer <= 0) {
      this.handlePhaseTimeout();
    }

    // 2. LOBBY: Spawn Agents + odds polling
    if (this.phase === GamePhase.LOBBY) {
      this.spawnAgentsFromMoltbook();
      this.oddsTick++;
      if (this.oddsTick % 3 === 0 && !this.oddsPolling) {
        this.pollOdds();
      }
    }

    // 3. (Betting is now LOBBY-only — no mid-ACTION lock needed)

    // 4. ACTION / ALL Phases: Bots Act
    if (
      this.phase === GamePhase.ACTION ||
      this.phase === GamePhase.LOBBY ||
      this.phase === GamePhase.MEETING
    ) {
      if (this.phase === GamePhase.ACTION) {
        // Movement is handled by movementTick() at 200ms intervals
        this.updateBotKill();
        this.updateTaskTicks();
        this.updateSabotageTick();
      }

      // Meeting-specific discussion (accusations, defenses, etc.)
      if (this.phase === GamePhase.MEETING) {
        this.updateMeetingDiscussion();
      }
      // Note: general chat is now handled by the comment stream (every 2s),
      // not by updateBotChat(). See constructor.
    }

    // 4. MEETING: Bot Logic (Vote)
    if (this.phase === GamePhase.MEETING && this.phaseTimer === 5) {
      // Vote at 5 seconds remaining
      this.autoVote();
    }

    // State broadcast is handled by movementTick() at 200ms intervals
  }

  /**
   * Fast tick (every 200ms): advance character positions and broadcast
   * state to all connected clients for smooth visual interpolation.
   */
  private movementTick() {
    if (this.phase === GamePhase.ACTION) {
      this.updateBotMovement();
    }

    // Broadcast State at 5× per second for smooth frontend interpolation
    this.onStateUpdate({
      phase: this.phase,
      timer: this.phaseTimer,
      players: this.players,
      meetingContext: this.meetingContext,
      winner: this.winner,
      taskProgress: this.getTaskProgress(),
      sabotage: this.activeSabotage
        ? { name: this.activeSabotage.name, timer: this.activeSabotage.timer }
        : null,
      onChainGameId:
        contractClient.gameId !== null
          ? contractClient.gameId.toString()
          : null,
      bettingOpen: this.phase === GamePhase.LOBBY,
      bettingTimer: this.getBettingTimer(),
      bettingOpensIn: this.getBettingOpensIn(),
    });
  }

  private handlePhaseTimeout() {
    switch (this.phase) {
      case GamePhase.LOBBY:
        // Need min 4 players to start
        if (Object.keys(this.players).length >= 4) {
          this.startGame();
        } else {
          // Extend lobby if not enough players
          this.phaseTimer = 10;
          console.log("Not enough players, extending Lobby...");
        }
        break;

      case GamePhase.ACTION: {
        // Time ran out — crewmates survived, they win!
        this.endGame("Crewmates Win — Survived!");
        break;
      }

      case GamePhase.MEETING:
        this.resolveMeeting();
        break;

      case GamePhase.ENDED:
        this.resetGame();
        break;
    }
  }

  private spawnAgentsFromMoltbook() {
    if (Object.keys(this.players).length >= this.MAX_PLAYERS) return;

    // Tick down cooldown; only attempt spawn when it reaches 0
    if (this.spawnCooldown > 0) {
      this.spawnCooldown--;
      return;
    }

    // Pop exactly 1 agent per spawn tick
    const agents = moltbookService.popSpawnQueue(1);
    if (agents.length > 0) {
      this.addPlayer(agents[0]);
      this.spawnCooldown = this.SPAWN_INTERVAL; // reset cooldown
    }
  }

  public addPlayer(agent: MoltbookAgent) {
    if (this.phase !== GamePhase.LOBBY) return; // Only join in Lobby
    if (Object.keys(this.players).length >= this.MAX_PLAYERS) return;

    if (!this.players[agent.id]) {
      this.players[agent.id] = {
        id: agent.id,
        name: agent.name,
        role: "Crewmate",
        alive: true,
        room: RoomType.CAFETERIA,
        x: 50 + (Math.random() * 4 - 2), // Random jitter +/- 2% to prevent stacking
        y: 20 + (Math.random() * 4 - 2),
        isBot: true,
        avatar: agent.avatar,
        owner: agent.owner,
        ownerAvatar: agent.ownerAvatar,
        ownerFollowers: agent.ownerFollowers,
        karma: agent.karma,
        posts: agent.posts,
      };
      this.map.spawnPlayer(agent.id);
      console.log(`Spawned ${agent.name} in Lobby`);
    }
  }

  /** Roll a float uniformly in [min, max] */
  private randRange(min: number, max: number): number {
    return min + Math.random() * (max - min);
  }

  private startGame() {
    console.log("Starting Game...");

    // Re-roll per-game balance parameters so every game feels different.
    // Ranges are tuned so the combination is genuinely 50/50 across many games.
    this.gameKillCooldown   = Math.round(this.randRange(28, 55)); // 28–55s
    this.gameKillChance     = this.randRange(0.10, 0.18);         // 10–18%
    this.gameMeetingChance  = this.randRange(0.35, 0.65);         // 35–65% body found
    this.gameVoteAccuracy   = this.randRange(0.35, 0.55);         // 35–55% correct vote
    this.gameSabotageChance = this.randRange(0.02, 0.05);         // 2–5%
    console.log(
      `[GameEngine] Game params — killCooldown:${this.gameKillCooldown}s ` +
      `killChance:${(this.gameKillChance*100).toFixed(0)}% ` +
      `meetingChance:${(this.gameMeetingChance*100).toFixed(0)}% ` +
      `voteAcc:${(this.gameVoteAccuracy*100).toFixed(0)}% ` +
      `sabotageChance:${(this.gameSabotageChance*100).toFixed(1)}%`
    );

    this.assignRoles();
    this.assignTasks();
    this.sabotageTriggered = false;
    this.activeSabotage = null;
    this.sabotageRepairTicks = 0;
    this.sabotageGraceTicks = SABOTAGE_COOLDOWN_TICKS;
    this.transitionTo(GamePhase.ACTION);
    this.phaseTimer = this.GAME_TIME;

    // Betting is LOBBY-only — lock immediately when ACTION starts
    this.bettingLocked = true;
    console.log("[GameEngine] Betting locked — ACTION started");
    // On-chain: lock the game that was seeded at LOBBY start
    const gameObjectId = contractClient.gameId;
    if (gameObjectId !== null) {
      contractClient
        .lockGame(gameObjectId)
        .catch((err) =>
          console.error("[ContractClient] lockGame failed:", err),
        );
    }
  }

  /** Assign 2-3 tasks to each crewmate from the pool (shuffled per game). */
  private assignTasks() {
    this.crewTasks = {};
    const crewmates = Object.values(this.players).filter(
      (p) => p.role === "Crewmate",
    );

    crewmates.forEach((p) => {
      // Shuffle task pool and pick 2 or 3 tasks
      const shuffled = [...TASK_POOL].sort(() => 0.5 - Math.random());
      const count = 3; // 3 tasks per crewmate — easier task win for balance
      this.crewTasks[p.id] = shuffled.slice(0, count).map((task) => ({
        task,
        completed: false,
        ticksRemaining: TASK_DURATION_TICKS,
      }));
    });

    const totalTasks = Object.values(this.crewTasks).reduce(
      (sum, tasks) => sum + tasks.length,
      0,
    );
    console.log(
      `Tasks assigned: ${totalTasks} total across ${crewmates.length} crewmates`,
    );
  }

  private updateBotMovement() {
    // Advance all waypoint paths by one tick (dead players stay put).
    this.map.tickMovement();

    // Sync position & room from MapManager back into Player objects for broadcast.
    Object.keys(this.players).forEach((id) => {
      if (!this.players[id].alive) return;
      const pos = this.map.getPosition(id);
      const room = this.map.getRoom(id);
      this.players[id].x = pos.x;
      this.players[id].y = pos.y;
      this.players[id].room = room;
    });
  }

  /** Pick a random element from an array */
  private pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  private updateMeetingDiscussion() {
    // Cooldown tick-down; only attempt a message when it reaches 0
    if (this.meetingChatCooldown > 0) {
      this.meetingChatCooldown--;
      return;
    }

    // Cap total messages per meeting so the chat doesn't flood
    if (this.meetingChatCount >= 7) return;

    const living = Object.values(this.players).filter((p) => p.alive);
    if (living.length < 2) return;

    const reporter = this.meetingContext.reporter
      ? this.players[this.meetingContext.reporter]
      : null;
    const bodyPlayer = this.meetingContext.bodyFound
      ? this.players[this.meetingContext.bodyFound]
      : null;

    let sender: Player;
    let content: string;

    // ── FIRST message is always the reporter's opening line ──
    if (this.meetingChatCount === 0 && reporter && reporter.alive) {
      sender = reporter;
      if (bodyPlayer) {
        content = this.pick([
          `I found ${bodyPlayer.name}'s body!`,
          `${bodyPlayer.name} is dead. I just found them.`,
          `Someone killed ${bodyPlayer.name}. I'm calling meeting.`,
          `I was walking by and saw ${bodyPlayer.name} on the ground.`,
        ]);
      } else {
        content = this.pick([
          "I called meeting. Something's off.",
          "Something sus is going on, guys.",
          "We need to talk. Now.",
          "I don't trust what's happening here.",
        ]);
      }
    } else {
      // ── Pick a random speaker (not the reporter for variety) ──
      const others = living.filter((p) => p.id !== (reporter?.id ?? ""));
      sender = others.length > 0 ? this.pick(others) : this.pick(living);

      // Pick a random "accused" target that isn't the sender
      const accuseTargets = living.filter((p) => p.id !== sender.id);
      const accused =
        accuseTargets.length > 0 ? this.pick(accuseTargets) : null;

      // Weight which category fires based on how far into the meeting we are.
      // Early → accusations/questions. Mid → reactions/redirects. Late → vote pressure.
      const progress = 1 - this.phaseTimer / this.MEETING_TIME; // 0 = start, 1 = end
      const roll = Math.random();

      if (progress < 0.35 && accused) {
        // ── Early: accusations & suspicion ──
        content = this.pick([
          `I think it's ${accused.name}.`,
          `${accused.name} was acting weird before this.`,
          `Where was ${accused.name} the whole time?`,
          `I saw ${accused.name} near ${bodyPlayer?.name ?? "the body"}.`,
          `${accused.name} didn't do any tasks, just wandered around.`,
          `Doesn't anyone else find ${accused.name} suspicious?`,
          `${accused.name} was alone for way too long.`,
          `I have a bad feeling about ${accused.name}.`,
        ]);
      } else if (progress < 0.65 || roll < 0.5) {
        // ── Mid: reactions, defenses, redirects ──
        // 40% chance the sender defends themselves or redirects
        if (Math.random() < 0.4 && accused) {
          // Sender talks about themselves or redirects to accused
          content = this.pick([
            `I was doing tasks the whole time, check the logs.`,
            `I literally just finished wires, I'm not impostor.`,
            `Why are we blaming ${accused.name}? Look at the others.`,
            `Can we get some actual evidence before voting?`,
            `I was in ${sender.room} the entire time.`,
            `This is taking too long. Someone just pick.`,
            `Has anyone actually seen who did it?`,
            `I don't have enough info to vote yet.`,
          ]);
        } else if (accused) {
          // Someone piles on or disagrees about the accused
          content = this.pick([
            `Yeah ${accused.name} does seem sus ngl.`,
            `I don't think it's ${accused.name} though.`,
            `Wait, ${accused.name} was with me earlier.`,
            `${accused.name} could be lying about that.`,
            `Let's not rush this. ${accused.name} might be innocent.`,
            `Actually ${accused.name} was doing tasks when I checked.`,
            `${accused.name} is clearly trying to deflect.`,
            `I dunno, ${accused.name} seemed normal to me.`,
          ]);
        } else {
          content = this.pick([
            `Can we just focus here?`,
            `Someone needs to say something useful.`,
            `This is going nowhere...`,
          ]);
        }
      } else {
        // ── Late: vote pressure & final calls ──
        content = this.pick([
          `We're running out of time, just vote already.`,
          `Skip if you're not sure, better than a random vote.`,
          `Okay final answer, who is it?`,
          `Time's almost up. Vote now or we lose.`,
          `I'm going with my gut on this one.`,
          `If we skip we're basically giving them the win.`,
          `Last chance to change your mind before the vote.`,
          `Everyone commit. No more changing.`,
        ]);
      }
    }

    this.onNewMessage({
      sender: sender.id,
      content,
      timestamp: Date.now(),
      type: "meeting",
    });
    this.meetingChatCount++;

    // Random cooldown 1-2s between messages so they trickle in naturally
    this.meetingChatCooldown = 1 + Math.floor(Math.random() * 2);
  }

  private updateBotKill() {
    // Impostors kill logic
    Object.values(this.players).forEach((p) => {
      if (p.role !== "Impostor" || !p.alive) return;

      // Tick down kill cooldown
      if (this.killCooldowns[p.id] && this.killCooldowns[p.id] > 0) {
        this.killCooldowns[p.id]--;
        return; // can't kill while on cooldown
      }

      // Each alive impostor gets a chance to kill per tick
      if (p.isBot && !p.isControlled) {
        // Find targets in same room — impostor can only kill if target is ALONE
        // (no other alive players in the room besides the impostor + target)
        const playersInRoom = Object.values(this.players).filter(
          (t) => t.alive && t.room === p.room,
        );
        const targets = playersInRoom.filter(
          (t) => t.id !== p.id && t.role !== "Impostor",
        );
        const witnesses = playersInRoom.filter(
          (t) => t.id !== p.id && t.role !== "Impostor",
        );
        // Only kill when exactly 1 crewmate is in the room (no witnesses)
        const canKill = witnesses.length === 1;

        if (canKill && targets.length > 0 && Math.random() < this.gameKillChance) {
          const victim = targets[Math.floor(Math.random() * targets.length)];
          this.killPlayer(p.id, victim.id);
          this.killCooldowns[p.id] = this.gameKillCooldown;
        }
      }
    });
  }

  private autoVote() {
    const aliveImpostors = Object.values(this.players).filter(
      (p) => p.role === "Impostor" && p.alive,
    );
    const aliveCrew = Object.values(this.players).filter(
      (p) => p.role === "Crewmate" && p.alive,
    );
    const allAlive = Object.values(this.players).filter((p) => p.alive);

    Object.values(this.players).forEach((p) => {
      if (!p.alive || p.isControlled) return;

      let choiceId: string;

      if (p.role === "Impostor") {
        // Impostors always vote for a random crewmate (never themselves)
        if (aliveCrew.length > 0) {
          choiceId = aliveCrew[Math.floor(Math.random() * aliveCrew.length)].id;
        } else {
          choiceId = "skip";
        }
      } else {
        // Crewmates: per-game chance to correctly suspect an impostor (simulated intuition)
        if (aliveImpostors.length > 0 && Math.random() < this.gameVoteAccuracy) {
          choiceId =
            aliveImpostors[Math.floor(Math.random() * aliveImpostors.length)]
              .id;
        } else {
          // 60% chance: vote randomly among all alive (including skip)
          const candidates = [...allAlive.filter((c) => c.id !== p.id)];
          candidates.push({ id: "skip" } as any);
          choiceId =
            candidates[Math.floor(Math.random() * candidates.length)].id ||
            "skip";
        }
      }

      this.meeting.castVote(p.id, choiceId);
      this.meetingContext.votesReceived[p.id] = choiceId;
    });
  }

  public killPlayer(killerId: string, targetId: string) {
    if (this.phase !== GamePhase.ACTION) return;

    const target = this.players[targetId];
    if (target && target.alive) {
      target.alive = false;
      this.map.stopPlayer(targetId);
      console.log(`🔪 ${this.players[killerId].name} killed ${target.name}`);

      if (Math.random() < this.gameMeetingChance) {
        // per-game chance body is discovered → triggers emergency meeting
        this.triggerMeeting(killerId, targetId);
      }
    }

    this.checkWinCondition();
  }

  /**
   * Win-condition check — evaluated after every kill, every vote resolution,
   * and every ACTION tick (for sabotage timer & task completion).
   *
   * Priority (highest first):
   *   1. Sabotage timer → 0          ⇒ Impostors Win (Sabotage)
   *   2. Impostors >= Crewmates alive ⇒ Impostors Win (Numerical)
   *   3. All impostors dead          ⇒ Crewmates Win (Elimination)
   *   4. All tasks completed         ⇒ Crewmates Win (Tasks)
   */
  private checkWinCondition() {
    if (this.phase === GamePhase.ENDED) return; // already ended

    const impostors = Object.values(this.players).filter(
      (p) => p.role === "Impostor" && p.alive,
    ).length;
    const crew = Object.values(this.players).filter(
      (p) => p.role === "Crewmate" && p.alive,
    ).length;

    // 1. Sabotage win is checked inside updateSabotageTick (timer decrement).
    //    If we got here after a sabotage win was already triggered, bail early.

    // 2. Numerical dominance
    if (impostors >= crew) {
      this.endGame(`Impostors Win (Domination: ${impostors}v${crew})`);
      return;
    }

    // 3. All impostors eliminated
    if (impostors === 0) {
      this.endGame("Crewmates Win!");
      return;
    }

    // 4. All tasks completed (only meaningful during ACTION)
    if (this.phase === GamePhase.ACTION && this.areAllTasksCompleted()) {
      this.endGame("Crewmates Win — Tasks!");
      return;
    }
  }

  // ── Task system ──────────────────────────────────────────────────────────

  /**
   * Each ACTION tick: for every alive crewmate, tick down any in-progress task
   * whose room matches the crewmate's current room.  Only one task ticks at a
   * time per player (the first incomplete one that matches).
   */
  private updateTaskTicks() {
    Object.entries(this.crewTasks).forEach(([playerId, tasks]) => {
      const player = this.players[playerId];
      if (!player || !player.alive) return;

      for (const entry of tasks) {
        if (entry.completed) continue;
        if (player.room === entry.task.room) {
          entry.ticksRemaining--;
          if (entry.ticksRemaining <= 0) {
            entry.completed = true;
            console.log(`✅ ${player.name} completed task: ${entry.task.name}`);
          }
          break; // only one task ticks per player per tick
        }
      }
    });

    // Check task-completion win after updating
    if (this.areAllTasksCompleted()) {
      this.endGame("Crewmates Win — Tasks!");
    }
  }

  /** True if every task assigned to every crewmate (alive or dead) is done. */
  private areAllTasksCompleted(): boolean {
    if (Object.keys(this.crewTasks).length === 0) return false;
    return Object.values(this.crewTasks).every((tasks) =>
      tasks.every((entry) => entry.completed),
    );
  }

  /**
   * Returns { completed, total } counts for the task progress bar.
   * Includes tasks from all crewmates (alive and dead — dead tasks can't
   * progress but still count toward the total).
   */
  private getTaskProgress(): { completed: number; total: number } {
    let completed = 0;
    let total = 0;
    Object.values(this.crewTasks).forEach((tasks) => {
      tasks.forEach((entry) => {
        total++;
        if (entry.completed) completed++;
      });
    });
    return { completed, total };
  }

  // ── Sabotage system ──────────────────────────────────────────────────────

  /**
   * Each ACTION tick:
   *   - Tick down the grace-period counter before sabotage is available.
   *   - With some probability, an alive impostor triggers sabotage (once per ACTION).
   *   - If sabotage is active, tick its timer down.  If it hits 0 → Impostors win.
   *   - If any alive crewmate is in the repair room, tick the repair counter.
   *     When repair counter reaches REPAIR_DURATION_TICKS the sabotage is cleared.
   */
  private updateSabotageTick() {
    // Grace period countdown
    if (this.sabotageGraceTicks > 0) {
      this.sabotageGraceTicks--;
    }

    // ── Trigger sabotage (multiple per ACTION, 30s cooldown after repair, after grace period) ──
    if (!this.activeSabotage && this.sabotageGraceTicks <= 0) {
      const impostorsAlive = Object.values(this.players).filter(
        (p) => p.role === "Impostor" && p.alive,
      );
      // per-game chance that an impostor sabotages
      if (impostorsAlive.length > 0 && Math.random() < this.gameSabotageChance) {
        this.activeSabotage = { ...this.pick(SABOTAGE_OPTIONS) }; // spread to avoid mutating the const
        this.sabotageRepairTicks = 0;
        console.log(
          `💥 Sabotage triggered: ${this.activeSabotage.name} (${this.activeSabotage.timer}s)`,
        );
      }
    }

    // ── Active sabotage logic ──
    if (this.activeSabotage) {
      // Check if any alive crewmate is in the repair room
      const repairRoom = this.activeSabotage.room;
      const repairer = Object.values(this.players).find(
        (p) => p.role === "Crewmate" && p.alive && p.room === repairRoom,
      );

      if (repairer) {
        this.sabotageRepairTicks++;
        if (this.sabotageRepairTicks >= REPAIR_DURATION_TICKS) {
          console.log(`🔧 Sabotage repaired by ${repairer.name}!`);
          this.activeSabotage = null;
          this.sabotageRepairTicks = 0;
          this.sabotageGraceTicks = 30; // 30s cooldown before next sabotage
          return; // sabotage cleared, no timer tick
        }
      }

      // Tick the sabotage timer down
      this.activeSabotage.timer--;
      if (this.activeSabotage.timer <= 0) {
        console.log(`💀 Sabotage not repaired in time! Impostors win.`);
        this.endGame("Impostors Win — Sabotage!");
        return;
      }
    }
  }

  private triggerMeeting(reporterId: string, bodyFoundId?: string) {
    console.log("🚨 Emergency Meeting!");
    // Save remaining ACTION time so we can restore it after the meeting
    this.savedActionTimer = this.phaseTimer;
    this.meetingContext = {
      reporter: reporterId,
      bodyFound: bodyFoundId,
      votesReceived: {},
    };
    this.meetingChatCooldown = 1; // first message fires after 1s (reporter line)
    this.meetingChatCount = 0;
    this.transitionTo(GamePhase.MEETING);
    this.phaseTimer = this.MEETING_TIME;
  }

  private transitionTo(newPhase: GamePhase) {
    this.phase = newPhase;
    this.onPhaseChange(newPhase);

    if (newPhase === GamePhase.MEETING) {
      this.meeting.startMeeting();
    } else if (newPhase === GamePhase.ACTION) {
      this.meeting.endMeeting();
    }
  }

  private resolveMeeting() {
    // Logic similar to before, but automated
    const votes = this.meeting.getVotes();
    const voteCounts: Record<string, number> = {};

    Object.values(votes).forEach((target) => {
      voteCounts[target] = (voteCounts[target] || 0) + 1;
    });

    // Find candidate with most votes
    let maxVotes = 0;
    let candidate: string | null = null;
    let tie = false;

    Object.entries(voteCounts).forEach(([target, count]) => {
      if (count > maxVotes) {
        maxVotes = count;
        candidate = target;
        tie = false;
      } else if (count === maxVotes) {
        tie = true;
      }
    });

    if (candidate && !tie && candidate !== "skip") {
      if (this.players[candidate]) {
        this.players[candidate].alive = false;
        this.map.stopPlayer(candidate);
        console.log(`👋 Ejected ${this.players[candidate].name}`);
      }
    }

    this.checkWinCondition();
    if (this.phase !== GamePhase.ENDED) {
      this.transitionTo(GamePhase.ACTION);
      // Restore the ACTION timer from before the meeting (not full reset)
      this.phaseTimer =
        this.savedActionTimer > 0 ? this.savedActionTimer : this.GAME_TIME;
    }
  }

  private assignRoles() {
    const playerIds = Object.keys(this.players);
    const impostorCount = 2;
    const shuffled = [...playerIds].sort(() => 0.5 - Math.random());

    shuffled.forEach((pid, index) => {
      if (index < impostorCount) {
        this.players[pid].role = "Impostor";
      } else {
        this.players[pid].role = "Crewmate";
      }
    });
    console.log(`Roles Assigned: ${impostorCount} Impostors`);
  }

  private async pollOdds() {
    this.oddsPolling = true;
    try {
      const gameObjectId = contractClient.gameId;
      if (!gameObjectId) return;
      const fields = await contractClient.getGameObject(gameObjectId);
      if (!fields) return;
      const crew = Number((fields.crewmates_pool as any)?.fields?.value ?? 0);
      const imp  = Number((fields.impostors_pool as any)?.fields?.value ?? 0);
      const total = crew + imp;
      this.onOddsUpdate?.({
        crewPool: crew,
        impPool: imp,
        total,
        crewOdds: total > 0 && crew > 0 ? (total / crew).toFixed(2) : "—",
        impOdds:  total > 0 && imp  > 0 ? (total / imp).toFixed(2)  : "—",
        timeLeft: this.phaseTimer,
      });
    } catch {
      // silent
    } finally {
      this.oddsPolling = false;
    }
  }

  private endGame(reason: string) {
    const elapsed = this.GAME_TIME - this.phaseTimer;
    console.log(
      `Game Ended: ${reason} | ACTION elapsed: ${elapsed}s / ${this.GAME_TIME}s | phaseTimer: ${this.phaseTimer}`,
    );
    this.winner = reason;
    this.transitionTo(GamePhase.ENDED);
    this.phaseTimer = this.RESET_TIME;

    let winningTeam = reason.includes("Crewmates")
      ? "Crewmates"
      : "Impostors";

    // Apply chat-vote probability modifier
    const voteModifier = this.onGetVoteModifier?.() ?? 0;
    if (voteModifier !== 0 && Math.random() < Math.abs(voteModifier)) {
      const flipped = winningTeam === "Crewmates" ? "Impostors" : "Crewmates";
      console.log(`[GameEngine] Vote modifier ${voteModifier.toFixed(2)} flipped winner: ${winningTeam} → ${flipped}`);
      winningTeam = flipped;
    }

    const gameObjectId = contractClient.gameId;
    const numericGameId = contractClient.numericGameId;
    const winningTeamNum = winningTeam === "Crewmates" ? 0 : 1;

    if (gameObjectId !== null) {
      contractClient
        .settleGame(gameObjectId, winningTeam as "Crewmates" | "Impostors")
        .then(() => {
          if (numericGameId !== null) {
            this.onGameEnded?.(gameObjectId, winningTeamNum);
          }
        })
        .catch((err) =>
          console.error("[ContractClient] settleGame failed:", err),
        );
    } else {
      console.log("[ContractClient] No active game object — skipping settle");
    }
  }

  private resetGame() {
    console.log("Resetting Game...");
    this.players = {}; // Clear all players
    this.map = new MapManager();
    this.meeting = new MeetingManager();
    this.phase = GamePhase.LOBBY;
    this.phaseTimer = this.LOBBY_TIME;
    this.spawnCooldown = 0; // Allow first spawn immediately next lobby
    this.meetingContext = { votesReceived: {} }; // Reset Meeting
    this.winner = null; // Clear winner
    // Clear task & sabotage state
    this.crewTasks = {};
    this.activeSabotage = null;
    this.sabotageRepairTicks = 0;
    this.sabotageTriggered = false;
    this.sabotageGraceTicks = 0;
    this.bettingLocked = false;
    this.onPhaseChange(GamePhase.LOBBY);

    // On-chain: seed pool to create a new Game object for the upcoming round
    contractClient
      .seedPool()
      .catch((err) =>
        console.error("[ContractClient] seedPool on lobby start failed:", err),
      );
  }

  public getState() {
    return {
      id: this.id,
      phase: this.phase,
      timer: this.phaseTimer,
      players: this.players,
      meetingContext: this.meetingContext,
      winner: this.winner,
      taskProgress: this.getTaskProgress(),
      sabotage: this.activeSabotage
        ? { name: this.activeSabotage.name, timer: this.activeSabotage.timer }
        : null,
      onChainGameId:
        contractClient.gameId !== null
          ? contractClient.gameId.toString()
          : null,
      bettingOpen: this.phase === GamePhase.LOBBY,
      bettingTimer: this.getBettingTimer(),
      bettingOpensIn: this.getBettingOpensIn(),
    };
  }

  /** Seconds remaining until betting closes. 0 when already locked. */
  private getBettingTimer(): number {
    if (this.phase === GamePhase.LOBBY) {
      return this.phaseTimer; // betting closes when LOBBY ends
    }
    return 0;
  }

  /** Seconds until betting opens again (only meaningful when betting is closed). */
  private getBettingOpensIn(): number {
    if (this.phase === GamePhase.ENDED) {
      return this.phaseTimer; // reset countdown → then LOBBY starts (betting open)
    }
    if (this.phase === GamePhase.ACTION) {
      return this.phaseTimer + this.RESET_TIME; // ACTION remaining + ENDED reset
    }
    if (this.phase === GamePhase.MEETING) {
      return (
        this.phaseTimer +
        (this.savedActionTimer > 0 ? this.savedActionTimer : 0) +
        this.RESET_TIME
      );
    }
    return 0;
  }
  // ── Controlled Agent Actions ──────────────────────────────────────────────

  public handleAction(playerId: string, action: string, payload: any) {
    const player = this.players[playerId];
    if (!player || !player.alive) return;

    // Safety check: only controlled players should use this, but for testing we allow all
    // if (!player.isControlled) return;

    switch (action) {
      case "move":
        // payload: { x, y }
        if (this.phase === GamePhase.ACTION || this.phase === GamePhase.LOBBY) {
          this.handleMove(player, payload.x, payload.y);
        }
        break;

      case "kill":
        // payload: { targetId }
        if (this.phase === GamePhase.ACTION) {
          this.handleKillAction(player, payload.targetId);
        }
        break;

      // TODO: Implement task completion logic for controlled agents

      case "vote":
        // payload: { targetId }
        if (this.phase === GamePhase.MEETING) {
          this.handleVoteAction(player, payload.targetId);
        }
        break;
    }
  }

  private handleMove(player: Player, x: number, y: number) {
    // Clamp to map bounds
    const newX = Math.max(0, Math.min(100, x));
    const newY = Math.max(0, Math.min(100, y));

    player.x = newX;
    player.y = newY;

    // Update MapManager state so it doesn't overwrite us next tick (and for room calc)
    this.map.setPosition(player.id, newX, newY);
    player.room = this.map.getRoom(player.id);
  }

  private handleKillAction(player: Player, targetId: string) {
    if (player.role !== "Impostor") return;

    // Check cooldown
    if (this.killCooldowns[player.id] && this.killCooldowns[player.id] > 0)
      return;

    const target = this.players[targetId];
    if (!target || !target.alive || target.role === "Impostor") return;

    // Distance check? For now simplified (must be in same room)
    if (target.room !== player.room) return;

    // Commit kill
    target.alive = false;
    this.killCooldowns[player.id] = this.gameKillCooldown;

    // Check win condition immediately? Default loop handles it next tick
  }

  private handleVoteAction(player: Player, targetId: string) {
    // Only vote if haven't voted yet
    if (this.meetingContext.votesReceived[player.id]) return;

    this.meetingContext.votesReceived[player.id] = targetId;
  }
}
