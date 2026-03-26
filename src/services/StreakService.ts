import * as fs from "fs";
import * as path from "path";

export interface StreakRecord {
  address: string;
  currentStreak: number;
  bestStreak: number;
  lastGameId: string | null;
}

const TIER_NAMES = [
  { min: 0,  max: 2,  name: "Normal" },
  { min: 3,  max: 4,  name: "Warm" },
  { min: 5,  max: 7,  name: "Hot" },
  { min: 8,  max: 10, name: "On Fire" },
  { min: 11, max: Infinity, name: "Unstoppable" },
];

class StreakService {
  private streaks = new Map<string, StreakRecord>();
  private readonly FILE = path.join(process.cwd(), "data", "streaks.json");

  load(): void {
    try {
      if (fs.existsSync(this.FILE)) {
        const data = JSON.parse(fs.readFileSync(this.FILE, "utf-8")) as StreakRecord[];
        for (const rec of data) {
          this.streaks.set(rec.address, rec);
        }
        console.log(`[StreakService] Loaded ${this.streaks.size} streak records`);
      }
    } catch {
      console.warn("[StreakService] Could not load streaks.json, starting fresh");
    }
  }

  private save(): void {
    try {
      const dir = path.dirname(this.FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.FILE, JSON.stringify([...this.streaks.values()], null, 2));
    } catch (err) {
      console.error("[StreakService] Failed to save:", err);
    }
  }

  /**
   * Update streaks after a game settles.
   * Returns addresses whose streak changed.
   */
  onGameSettled(
    gameId: string,
    winningTeam: number,
    bettors: Array<{ address: string; team: number }>,
  ): string[] {
    const changed: string[] = [];

    for (const { address, team } of bettors) {
      const prev = this.streaks.get(address) ?? {
        address,
        currentStreak: 0,
        bestStreak: 0,
        lastGameId: null,
      };

      // Guard: don't double-process the same game
      if (prev.lastGameId === gameId) continue;

      const won = team === winningTeam;
      const next: StreakRecord = {
        address,
        currentStreak: won ? prev.currentStreak + 1 : 0,
        bestStreak: won ? Math.max(prev.bestStreak, prev.currentStreak + 1) : prev.bestStreak,
        lastGameId: gameId,
      };
      this.streaks.set(address, next);
      changed.push(address);
    }

    if (changed.length > 0) this.save();
    return changed;
  }

  getStreak(address: string): StreakRecord {
    return (
      this.streaks.get(address) ?? {
        address,
        currentStreak: 0,
        bestStreak: 0,
        lastGameId: null,
      }
    );
  }

  getTop(limit: number): StreakRecord[] {
    return [...this.streaks.values()]
      .sort((a, b) => b.bestStreak - a.bestStreak)
      .slice(0, limit);
  }

  tierName(streak: number): string {
    return TIER_NAMES.find((t) => streak >= t.min && streak <= t.max)?.name ?? "Normal";
  }
}

export const streakService = new StreakService();
