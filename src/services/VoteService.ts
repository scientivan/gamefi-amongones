import { SuiClient } from "@onelabs/sui/client";

export interface VoteTally {
  gameObjectId: string;
  counts: [number, number, number, number]; // [emergency, sabotage, report, voteout]
}

// Probability modifier per vote type (net shift on Impostors winning)
const MODIFIERS = [
  -0.05, // 0: Emergency Meeting → Impostors less likely to win
  +0.05, // 1: Sabotage           → Impostors more likely to win
  -0.03, // 2: Report Body        → Impostors less likely to win
   0,    // 3: Vote Out           → random, handled per-vote
];

class VoteService {
  private current: VoteTally | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private client: SuiClient;
  private packageId: string;
  private voteCallback: ((tally: VoteTally) => void) | null = null;
  private processedTxs = new Set<string>();
  private voteOutModifier = 0; // accumulated random modifier from vote-out votes

  constructor() {
    const rpcUrl = process.env.RPC_URL || "https://rpc-testnet.onelabs.cc:443";
    this.client = new SuiClient({ url: rpcUrl });
    this.packageId = process.env.PACKAGE_ID || "";
  }

  onVoteEvent(cb: (tally: VoteTally) => void): void {
    this.voteCallback = cb;
  }

  startForGame(gameObjectId: string, gameNumericId: number): void {
    this.stopPolling();
    this.current = { gameObjectId, counts: [0, 0, 0, 0] };
    this.processedTxs.clear();
    this.voteOutModifier = 0;

    console.log(`[VoteService] Polling votes for game ${gameObjectId} (id=${gameNumericId})`);
    this.pollInterval = setInterval(async () => {
      await this.poll(gameNumericId);
    }, 2000);
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.current = null;
  }

  getCurrentModifier(): number {
    if (!this.current) return 0;
    const counts = this.current.counts;
    let modifier = 0;
    modifier += counts[0] * MODIFIERS[0];
    modifier += counts[1] * MODIFIERS[1];
    modifier += counts[2] * MODIFIERS[2];
    modifier += this.voteOutModifier;
    // Cap at ±0.25
    return Math.max(-0.25, Math.min(0.25, modifier));
  }

  getCurrentTally(): VoteTally | null {
    return this.current;
  }

  private async poll(gameNumericId: number): Promise<void> {
    if (!this.packageId || !this.current) return;
    try {
      const events = await this.client.queryEvents({
        query: { MoveEventType: `${this.packageId}::game::EvVoteCast` },
        limit: 200,
      });

      let changed = false;
      for (const e of events.data) {
        const txDigest = e.id.txDigest;
        if (this.processedTxs.has(txDigest)) continue;

        const j = e.parsedJson as Record<string, unknown> | null;
        if (!j) continue;
        if (Number(j.game_id) !== gameNumericId) continue;

        this.processedTxs.add(txDigest);
        const voteType = Number(j.vote_type) as 0 | 1 | 2 | 3;
        if (voteType >= 0 && voteType <= 3) {
          this.current!.counts[voteType]++;
          // Vote Out modifier is random per vote
          if (voteType === 3) {
            this.voteOutModifier += Math.random() < 0.5 ? -0.03 : 0.03;
          }
          changed = true;
        }
      }

      if (changed && this.voteCallback) {
        this.voteCallback({ ...this.current! });
      }
    } catch (err) {
      // Silent fail — votes are optional, game continues without them
    }
  }
}

export const voteService = new VoteService();
