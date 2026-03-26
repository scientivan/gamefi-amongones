import { SuiClient, getFullnodeUrl } from "@onelabs/sui/client";
import { decodeSuiPrivateKey } from "@onelabs/sui/cryptography";
import { Ed25519Keypair } from "@onelabs/sui/keypairs/ed25519";
import { Transaction } from "@onelabs/sui/transactions";
import { fromHex } from "@onelabs/sui/utils";

// ── Team enum values (must match Move contract) ───────────────────────────────
export const Team = {
  Crewmates: 0,
  Impostors: 1,
} as const;

// ── Singleton client ─────────────────────────────────────────────────────────
class ContractClient {
  private client: SuiClient;
  private keypair: Ed25519Keypair;
  private packageId: string;
  private adminCapId: string;
  private housePoolId: string;

  private currentGameObjectId: string | null = null;
  private currentNumericGameId: number | null = null;

  // Seed amounts in MIST (1 OCT = 1_000_000_000 MIST). Configurable via env.
  private seedCrewmates: bigint;
  private seedImpostors: bigint;

  constructor() {
    const rpcUrl = process.env.RPC_URL || getFullnodeUrl("mainnet");
    const privateKey = process.env.PRIVATE_KEY;
    const packageId = process.env.PACKAGE_ID;
    const adminCapId = process.env.ADMIN_CAP_ID;
    const housePoolId = process.env.HOUSE_POOL_ID;

    if (!privateKey || !packageId || !adminCapId || !housePoolId) {
      throw new Error(
        "PRIVATE_KEY, PACKAGE_ID, ADMIN_CAP_ID, and HOUSE_POOL_ID must be set in .env",
      );
    }

    this.keypair = privateKey.startsWith("suiprivkey")
      ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(privateKey).secretKey)
      : Ed25519Keypair.fromSecretKey(fromHex(privateKey));
    this.client = new SuiClient({ url: rpcUrl });
    this.packageId = packageId;
    this.adminCapId = adminCapId;
    this.housePoolId = housePoolId;

    // Default seed: 0.1 OCT each side. Override with SEED_CREWMATES / SEED_IMPOSTORS env vars.
    this.seedCrewmates = BigInt(process.env.SEED_CREWMATES || "100000000"); // 0.1 OCT
    this.seedImpostors = BigInt(process.env.SEED_IMPOSTORS || "100000000"); // 0.1 OCT

    console.log(
      `[ContractClient] Connected to OneChain package @ ${this.packageId}`,
    );
  }

  /** Returns the current Game Object ID (Sui Object ID), null if no game seeded yet. */
  get gameId(): string | null {
    return this.currentGameObjectId;
  }

  /** Returns the numeric game_id (u64 counter) for the current game. */
  get numericGameId(): number | null {
    return this.currentNumericGameId;
  }

  // ── Read helpers ─────────────────────────────────────────────────────────

  /** Get current house pool OCT balance in MIST. */
  private async getHousePoolBalance(): Promise<bigint> {
    try {
      const res = await this.client.getObject({
        id: this.housePoolId,
        options: { showContent: true },
      });
      const fields = (res.data?.content as any)?.fields;
      // Balance<OCT> is stored as { fields: { value: "..." } } or directly as a string
      const raw = fields?.balance;
      const value =
        typeof raw === "object" && raw !== null
          ? (raw as any)?.fields?.value ?? 0
          : raw ?? 0;
      return BigInt(String(value));
    } catch {
      return BigInt(0);
    }
  }

  // ── Write calls ──────────────────────────────────────────────────────────

  /**
   * Seeds the house pool — creates a new Game shared object.
   * Must be called at LOBBY start. Returns the new Game Object ID.
   *
   * Strategy:
   *  1. If seeds > 0 AND pool balance is insufficient → include a `deposit` call
   *     in the SAME PTB as `seed_pool` (avoids stale-object-version errors).
   *  2. If that still fails (e.g. admin wallet has no OCT) → retry with seed=0.
   */
  async seedPool(): Promise<string> {
    const total = this.seedCrewmates + this.seedImpostors;

    // Try with configured seeds first (may include auto-deposit in same PTB)
    if (total > BigInt(0)) {
      try {
        return await this._doSeedPool(this.seedCrewmates, this.seedImpostors);
      } catch (err) {
        console.warn(
          `[ContractClient] seedPool with seeds failed: ${err}. Retrying with seed=0...`,
        );
      }
    }

    // Fallback: seed=0, always succeeds (0 >= 0 passes the contract assertion)
    console.log("[ContractClient] Seeding with seed=0 (no house liquidity).");
    return await this._doSeedPool(BigInt(0), BigInt(0));
  }

  /**
   * Internal: build and execute one PTB that optionally deposits first, then seeds.
   * Combining both calls in a single PTB prevents the stale-object-version error
   * that occurs when two consecutive transactions reference the same owned object
   * (AdminCap) and the first tx bumps its version before the second is submitted.
   */
  private async _doSeedPool(
    crewSeed: bigint,
    impSeed: bigint,
  ): Promise<string> {
    const total = crewSeed + impSeed;
    const tx = new Transaction();

    // If seeds > 0 and the pool doesn't have enough, prepend a deposit call
    if (total > BigInt(0)) {
      const balance = await this.getHousePoolBalance();
      if (balance < total) {
        const needed = total - balance;
        console.log(
          `[ContractClient] Pool balance (${balance}) < needed (${total}). Adding deposit of ${needed} MIST to same PTB...`,
        );
        // Split OCT from admin gas coin and deposit — same tx as seed_pool below
        const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(needed)]);
        tx.moveCall({
          target: `${this.packageId}::game::deposit`,
          arguments: [
            tx.object(this.adminCapId),
            tx.object(this.housePoolId),
            coin,
          ],
        });
      }
    }

    console.log(
      `[ContractClient] seedPool(crew=${crewSeed}, imp=${impSeed})...`,
    );

    tx.moveCall({
      target: `${this.packageId}::game::seed_pool`,
      arguments: [
        tx.object(this.adminCapId),
        tx.object(this.housePoolId),
        tx.pure.u64(crewSeed),
        tx.pure.u64(impSeed),
        tx.object("0x6"), // Sui Clock
      ],
    });

    const result = await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
      options: { showEffects: true },
    });

    // Extract Game Object ID from effects.created
    const created = result.effects?.created ?? [];
    const gameObj = created.find(
      (obj: { owner: unknown; reference?: { objectId: string } }) =>
        typeof obj.owner === "object" &&
        obj.owner !== null &&
        "Shared" in (obj.owner as object),
    );
    const gameObjectId = gameObj?.reference?.objectId ?? "";

    if (!gameObjectId) {
      throw new Error(
        "[ContractClient] seedPool: could not find created Game object ID in effects",
      );
    }

    this.currentGameObjectId = gameObjectId;

    // Read numeric game_id from the game object
    try {
      const fields = await this.getGameObject(gameObjectId);
      this.currentNumericGameId = Number(fields?.game_id ?? 0);
    } catch {
      this.currentNumericGameId = null;
    }

    console.log(
      `[ContractClient] Game seeded — objectId: ${gameObjectId}, numericId: ${this.currentNumericGameId}`,
    );
    return gameObjectId;
  }

  /**
   * Locks the current game — no more bets accepted.
   */
  async lockGame(gameObjectId: string): Promise<void> {
    console.log(`[ContractClient] lockGame(${gameObjectId})...`);

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::game::lock_game`,
      arguments: [
        tx.object(this.adminCapId),
        tx.object(gameObjectId),
        tx.object("0x6"), // Sui Clock
      ],
    });

    await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
    });

    console.log(`[ContractClient] Game locked: ${gameObjectId}`);
  }

  /**
   * Settles the current game with the winning team.
   * Fee + seed share auto-return to HousePool.
   */
  async settleGame(
    gameObjectId: string,
    winner: "Crewmates" | "Impostors",
  ): Promise<void> {
    const teamValue = winner === "Crewmates" ? Team.Crewmates : Team.Impostors;
    console.log(`[ContractClient] settleGame(${gameObjectId}, ${winner})...`);

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::game::settle_game`,
      arguments: [
        tx.object(this.adminCapId),
        tx.object(gameObjectId),
        tx.object(this.housePoolId),
        tx.pure.u8(teamValue),
        tx.object("0x6"), // Sui Clock
      ],
    });

    await this.client.signAndExecuteTransaction({
      signer: this.keypair,
      transaction: tx,
    });

    this.currentGameObjectId = null;
    this.currentNumericGameId = null;
    console.log(`[ContractClient] Game settled — winner: ${winner}`);
  }

  // ── Read calls ───────────────────────────────────────────────────────────

  /** Read a game object's fields from chain. */
  async getGameObject(objectId: string): Promise<Record<string, unknown> | null> {
    if (!objectId) return null;
    try {
      const res = await this.client.getObject({
        id: objectId,
        options: { showContent: true },
      });
      const content = res.data?.content as
        | { fields?: Record<string, unknown> }
        | undefined;
      return content?.fields ?? null;
    } catch {
      return null;
    }
  }

  /** Query EvBetPlaced events and return all bettors for a given numeric game ID. */
  async getBettorsForGame(
    numericGameId: number,
  ): Promise<Array<{ address: string; team: number }>> {
    try {
      const events = await this.client.queryEvents({
        query: { MoveEventType: `${this.packageId}::game::EvBetPlaced` },
        limit: 1000,
      });
      return events.data
        .filter(
          (e) => Number((e.parsedJson as any)?.game_id) === numericGameId,
        )
        .map((e) => ({
          address: String((e.parsedJson as any).bettor),
          team: Number((e.parsedJson as any).team),
        }));
    } catch {
      return [];
    }
  }
}

// Export singleton
export const contractClient = new ContractClient();
