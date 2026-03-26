import * as fs from "fs";
import * as path from "path";
import { SuiClient, getFullnodeUrl } from "@onelabs/sui/client";
import { Ed25519Keypair } from "@onelabs/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@onelabs/sui/cryptography";
import { Transaction } from "@onelabs/sui/transactions";
import { fromHex } from "@onelabs/sui/utils";
import { streakService } from "./StreakService";

// ── Types ─────────────────────────────────────────────────────────────────────

type MissionKind =
  | "bet_count"      // total bets placed in period
  | "bet_crewmates"  // bets for Crewmates (team 0) in period
  | "max_bet"        // at least one bet >= 0.1 OCT in period
  | "win_count"      // settled winning bets in period
  | "comeback"       // win after 2 consecutive losses in period
  | "vote_count"     // votes cast in period
  | "days_bet"       // distinct UTC days with ≥1 bet this week
  | "total_bet_mist" // cumulative MIST bet in period (target = 500_000_000)
  | "consec_wins"    // consecutive win streak (from StreakService)
  | "top10";         // in top-10 P&L leaderboard this week

interface MissionDef {
  id: string;
  type: "daily" | "weekly";
  title: string;
  description: string;
  req: { kind: MissionKind; target: number };
  reward: bigint;
}

interface MissionProgress {
  missionId: string;
  address: string;
  progress: number;
  completed: boolean;
  claimed: boolean;
  periodKey: string;
}

export interface MissionWithProgress extends MissionDef {
  progress: number;
  completed: boolean;
  claimed: boolean;
  periodKey: string;
}

// ── Mission definitions (matches FEATURE_PROPOSALS.md) ───────────────────────

const MAX_BET_THRESHOLD = 100_000_000; // 0.1 OCT in MIST

const MISSIONS: MissionDef[] = [
  // ── Daily ──────────────────────────────────────────────────────────────────
  {
    id: "daily_first_bet",
    type: "daily",
    title: "First Bet",
    description: "Place your first bet today",
    req: { kind: "bet_count", target: 1 },
    reward: 1_000_000n,
  },
  {
    id: "daily_consistent_crewmate",
    type: "daily",
    title: "Consistent Crewmate",
    description: "Bet on Crewmates 3 times today",
    req: { kind: "bet_crewmates", target: 3 },
    reward: 2_000_000n,
  },
  {
    id: "daily_risk_taker",
    type: "daily",
    title: "Risk Taker",
    description: "Place a max bet (0.1 OCT) at least once today",
    req: { kind: "max_bet", target: 1 },
    reward: 3_000_000n,
  },
  {
    id: "daily_comeback",
    type: "daily",
    title: "Comeback Kid",
    description: "Win a bet after 2 consecutive losses",
    req: { kind: "comeback", target: 1 },
    reward: 5_000_000n,
  },
  {
    id: "daily_vote",
    type: "daily",
    title: "Vote Participant",
    description: "Vote in at least 1 game event today",
    req: { kind: "vote_count", target: 1 },
    reward: 1_000_000n,
  },
  // ── Weekly ─────────────────────────────────────────────────────────────────
  {
    id: "weekly_dedicated",
    type: "weekly",
    title: "Dedicated Player",
    description: "Bet on at least 5 different days this week",
    req: { kind: "days_bet", target: 5 },
    reward: 5_000_000n,
  },
  {
    id: "weekly_whale",
    type: "weekly",
    title: "Whale Week",
    description: "Total bets exceed 0.5 OCT this week",
    req: { kind: "total_bet_mist", target: 500_000_000 },
    reward: 10_000_000n,
  },
  {
    id: "weekly_streak",
    type: "weekly",
    title: "Winning Streak",
    description: "Achieve a 5-game win streak",
    req: { kind: "consec_wins", target: 5 },
    reward: 10_000_000n,
  },
  {
    id: "weekly_community",
    type: "weekly",
    title: "Community Leader",
    description: "Vote in 10+ game events this week",
    req: { kind: "vote_count", target: 10 },
    reward: 5_000_000n,
  },
  {
    id: "weekly_top10",
    type: "weekly",
    title: "Top 10",
    description: "Reach the top 10 leaderboard this week",
    req: { kind: "top10", target: 1 },
    reward: 10_000_000n,
  },
];

// ── Period helpers ─────────────────────────────────────────────────────────────

function periodKey(type: "daily" | "weekly"): string {
  const now = new Date();
  if (type === "daily") {
    return now.toISOString().slice(0, 10); // "2026-03-25"
  }
  // ISO week number
  const jan4 = new Date(Date.UTC(now.getUTCFullYear(), 0, 4));
  const startOfWeek1 = new Date(jan4);
  startOfWeek1.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  const weekNum = Math.ceil(
    ((now.getTime() - startOfWeek1.getTime()) / 86400000 + 1) / 7,
  );
  return `${now.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

function startOfDayMs(): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeekMs(): number {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day; // offset to Monday
  const monday = new Date(now);
  monday.setUTCDate(now.getUTCDate() + diff);
  monday.setUTCHours(0, 0, 0, 0);
  return monday.getTime();
}

// ── Service ────────────────────────────────────────────────────────────────────

class MissionService {
  // Key: `${address}::${missionId}::${periodKey}`
  private data = new Map<string, MissionProgress>();
  private readonly FILE = path.join(process.cwd(), "data", "missions.json");
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private packageId: string;
  // Rate-limit chain queries: one sync per address per SYNC_TTL ms
  private lastSync = new Map<string, number>();
  private readonly SYNC_TTL = 60_000;

  constructor() {
    const rpcUrl = process.env.RPC_URL || getFullnodeUrl("mainnet");
    this.client = new SuiClient({ url: rpcUrl });
    this.packageId = process.env.PACKAGE_ID || "";
    const privateKey = process.env.PRIVATE_KEY || "";
    this.keypair = privateKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(privateKey).secretKey)
      : Ed25519Keypair.fromSecretKey(fromHex(privateKey));
  }

  load(): void {
    try {
      if (fs.existsSync(this.FILE)) {
        const arr = JSON.parse(
          fs.readFileSync(this.FILE, "utf-8"),
        ) as MissionProgress[];
        for (const p of arr) {
          this.data.set(this.key(p.address, p.missionId, p.periodKey), p);
        }
        console.log(
          `[MissionService] Loaded ${this.data.size} progress records`,
        );
      }
    } catch {
      console.warn(
        "[MissionService] Could not load missions.json, starting fresh",
      );
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        this.FILE,
        JSON.stringify([...this.data.values()], null, 2),
      );
    } catch (err) {
      console.error("[MissionService] Failed to save:", err);
    }
  }

  private key(address: string, missionId: string, pk: string): string {
    return `${address}::${missionId}::${pk}`;
  }

  private getOrCreate(address: string, mission: MissionDef): MissionProgress {
    const pk = periodKey(mission.type);
    const k = this.key(address, mission.id, pk);
    if (!this.data.has(k)) {
      this.data.set(k, {
        missionId: mission.id,
        address,
        progress: 0,
        completed: false,
        claimed: false,
        periodKey: pk,
      });
    }
    return this.data.get(k)!;
  }

  /**
   * Queries on-chain events and updates mission progress for the given address.
   * Rate-limited: one chain sync per address per 60 seconds.
   */
  async syncProgressFromChain(address: string): Promise<void> {
    const now = Date.now();
    if ((now - (this.lastSync.get(address) ?? 0)) < this.SYNC_TTL) return;
    this.lastSync.set(address, now);

    if (!this.packageId) return;

    try {
      const dayStart = startOfDayMs();
      const weekStart = startOfWeekMs();

      // Fetch bet, settlement, vote, and claim events in parallel
      const [betEvents, settledEvents, voteEvents, claimEvents] =
        await Promise.all([
          this.client.queryEvents({
            query: {
              MoveEventType: `${this.packageId}::game::EvBetPlaced`,
            },
            limit: 1000,
          }),
          this.client.queryEvents({
            query: {
              MoveEventType: `${this.packageId}::game::EvGameSettled`,
            },
            limit: 1000,
          }),
          this.client.queryEvents({
            query: {
              MoveEventType: `${this.packageId}::game::EvVoteCast`,
            },
            limit: 1000,
          }),
          this.client.queryEvents({
            query: {
              MoveEventType: `${this.packageId}::game::EvPayoutClaimed`,
            },
            limit: 1000,
          }),
        ]);

      // game_id (u64) → winning team number
      const winMap = new Map<string, number>();
      for (const e of settledEvents.data) {
        const j = e.parsedJson as Record<string, unknown> | null;
        if (j?.game_id != null) {
          winMap.set(String(j.game_id), Number(j.winning_team));
        }
      }

      const tsOf = (e: { timestampMs?: string | number | null }): number =>
        Number(e.timestampMs ?? 0);

      // Filter all events to this address, then split by period
      const allMyBets = betEvents.data.filter(
        (e) => (e.parsedJson as any)?.bettor === address,
      );
      const myBetsDaily = allMyBets.filter((e) => tsOf(e) >= dayStart);
      const myBetsWeekly = allMyBets.filter((e) => tsOf(e) >= weekStart);

      const allMyVotes = voteEvents.data.filter(
        (e) => (e.parsedJson as any)?.voter === address,
      );
      const myVotesDaily = allMyVotes.filter((e) => tsOf(e) >= dayStart);
      const myVotesWeekly = allMyVotes.filter((e) => tsOf(e) >= weekStart);

      // "Comeback" check for daily: win a bet after 2+ consecutive losses
      const comebackDone = (() => {
        const sorted = [...myBetsDaily].sort((a, b) => tsOf(a) - tsOf(b));
        let lossRun = 0;
        for (const e of sorted) {
          const j = e.parsedJson as any;
          const winner = winMap.get(String(j?.game_id));
          if (winner === undefined) continue; // game not yet settled
          const won = Number(j.team) === winner;
          if (won && lossRun >= 2) return true;
          lossRun = won ? 0 : lossRun + 1;
        }
        return false;
      })();

      // Top-10 P&L leaderboard for current week
      let isTop10 = false;
      try {
        const pnlMap = new Map<string, bigint>();

        for (const e of betEvents.data) {
          if (tsOf(e) < weekStart) continue;
          const j = e.parsedJson as any;
          if (!j?.bettor || !winMap.has(String(j.game_id))) continue;
          const addr = String(j.bettor);
          pnlMap.set(addr, (pnlMap.get(addr) ?? BigInt(0)) - BigInt(String(j.amount)));
        }

        for (const e of claimEvents.data) {
          if (tsOf(e) < weekStart) continue;
          const j = e.parsedJson as any;
          if (!j?.bettor) continue;
          const addr = String(j.bettor);
          pnlMap.set(addr, (pnlMap.get(addr) ?? BigInt(0)) + BigInt(String(j.amount)));
        }

        const sorted = [...pnlMap.entries()].sort((a, b) =>
          b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0,
        );
        const rank = sorted.findIndex(([addr]) => addr === address);
        isTop10 = rank >= 0 && rank < 10;
      } catch {
        // Keep existing top10 progress on failure
      }

      let changed = false;

      for (const m of MISSIONS) {
        const prog = this.getOrCreate(address, m);
        if (prog.claimed) continue; // already claimed, nothing to update

        const isDaily = m.type === "daily";
        const periodBets = isDaily ? myBetsDaily : myBetsWeekly;
        const periodVotes = isDaily ? myVotesDaily : myVotesWeekly;

        let newProgress: number;

        switch (m.req.kind) {
          case "bet_count":
            newProgress = periodBets.length;
            break;

          case "bet_crewmates":
            newProgress = periodBets.filter(
              (e) => Number((e.parsedJson as any)?.team) === 0,
            ).length;
            break;

          case "max_bet":
            newProgress = periodBets.some(
              (e) => Number((e.parsedJson as any)?.amount) >= MAX_BET_THRESHOLD,
            )
              ? 1
              : 0;
            break;

          case "win_count":
            newProgress = periodBets.filter((e) => {
              const j = e.parsedJson as any;
              const winner = winMap.get(String(j?.game_id));
              return winner !== undefined && Number(j.team) === winner;
            }).length;
            break;

          case "comeback":
            newProgress = comebackDone ? 1 : 0;
            break;

          case "vote_count":
            newProgress = periodVotes.length;
            break;

          case "days_bet": {
            const days = new Set(
              periodBets.map((e) => {
                const d = new Date(tsOf(e));
                return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
              }),
            );
            newProgress = days.size;
            break;
          }

          case "total_bet_mist":
            newProgress = periodBets.reduce(
              (sum, e) =>
                sum + Number((e.parsedJson as any)?.amount ?? 0),
              0,
            );
            break;

          case "consec_wins":
            newProgress = streakService.getStreak(address).currentStreak;
            break;

          case "top10":
            newProgress = isTop10 ? 1 : 0;
            break;

          default:
            continue;
        }

        // Never regress cached progress (chain queries may be incomplete mid-period)
        if (newProgress > prog.progress) {
          prog.progress = newProgress;
          changed = true;
        }
        if (!prog.completed && prog.progress >= m.req.target) {
          prog.completed = true;
          changed = true;
        }
      }

      if (changed) this.save();
      console.log(
        `[MissionService] Chain sync done for ${address.slice(0, 8)}...`,
      );
    } catch (err) {
      console.error("[MissionService] syncProgressFromChain failed:", err);
    }
  }

  /**
   * Immediate update from the game engine after each game.
   * Handles kinds the game engine can compute without chain queries.
   */
  onGameResult(address: string, won: boolean, consecutiveWins: number): void {
    let changed = false;
    for (const m of MISSIONS) {
      const prog = this.getOrCreate(address, m);
      if (prog.completed) continue;

      switch (m.req.kind) {
        case "bet_count":
          prog.progress++;
          break;
        case "win_count":
          if (won) prog.progress++;
          break;
        case "consec_wins":
          prog.progress = consecutiveWins;
          break;
        default:
          continue;
      }

      if (prog.progress >= m.req.target) {
        prog.completed = true;
      }
      changed = true;
    }
    if (changed) this.save();
  }

  getMissions(address: string): MissionWithProgress[] {
    return MISSIONS.map((m) => {
      const prog = this.getOrCreate(address, m);
      return {
        ...m,
        progress: prog.progress,
        completed: prog.completed,
        claimed: prog.claimed,
        periodKey: prog.periodKey,
      };
    });
  }

  async claimMission(
    address: string,
    missionId: string,
  ): Promise<{ txDigest: string }> {
    const mission = MISSIONS.find((m) => m.id === missionId);
    if (!mission) throw new Error("Unknown mission");

    const pk = periodKey(mission.type);
    const k = this.key(address, missionId, pk);
    const prog = this.data.get(k);

    if (!prog?.completed) throw new Error("Mission not completed");
    if (prog.claimed) throw new Error("Already claimed");

    // Mark claimed before tx to prevent double-claim
    prog.claimed = true;
    this.save();

    try {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [mission.reward]);
      tx.transferObjects([coin], tx.pure.address(address));
      const result = await this.client.signAndExecuteTransaction({
        signer: this.keypair,
        transaction: tx,
        options: { showEffects: true },
      });
      console.log(
        `[MissionService] Paid ${mission.reward} MIST to ${address} for ${missionId} — tx: ${result.digest}`,
      );
      return { txDigest: result.digest };
    } catch (err) {
      // Revert on failure so user can retry
      prog.claimed = false;
      this.save();
      throw err;
    }
  }
}

export const missionService = new MissionService();
