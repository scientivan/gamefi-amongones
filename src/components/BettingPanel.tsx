"use client";

import { useState, useEffect, useMemo } from "react";
import {
  useCurrentAccount,
  useSuiClient,
  useSuiClientQuery,
  useSignAndExecuteTransaction,
  ConnectButton,
} from "@mysten/dapp-kit";
import { Transaction } from "@mysten/sui/transactions";
import { getKeypairFromEnv } from "@/lib/directSigner";
import {
  savePendingBet,
  loadPendingBet,
  clearPendingBet,
} from "@/lib/persistence";
import { useUserBet } from "@/hooks/useUserBet";
import { useUnclaimedPayouts } from "@/hooks/useUnclaimedPayouts";
import type { OddsData, StreakRecord } from "@/hooks/useGameState";

const Team = { Crewmates: 0, Impostors: 1 } as const;
const teamName = (t: number | null) =>
  t === 0 ? "Crewmates" : t === 1 ? "Impostors" : "—";
const formatSui = (mist: bigint | string | undefined) => {
  if (!mist) return "0";
  return (Number(mist) / 1_000_000_000).toFixed(4);
};

interface BettingPanelProps {
  phase: string;
  winner?: string | null;
  onChainGameId?: string | null;
  bettingOpen?: boolean;
  bettingTimer?: number;
  bettingOpensIn?: number;
  odds?: OddsData;
  streak?: StreakRecord;
}

type BetTeam = "Crewmates" | "Impostors" | null;

const formatBetTimer = (secs: number) =>
  `${Math.floor(secs / 60)}:${(secs % 60).toString().padStart(2, "0")}`;

const STREAK_TIERS = [
  { min: 0, max: 2, name: "Normal", color: "#a8d8ea" },
  { min: 3, max: 4, name: "Warm", color: "#ffd700" },
  { min: 5, max: 7, name: "Hot", color: "#ff8c42" },
  { min: 8, max: 10, name: "On Fire", color: "#ff4444" },
  { min: 11, max: Infinity, name: "Unstoppable", color: "#ff00ff" },
];
const streakTier = (n: number) =>
  STREAK_TIERS.find((t) => n >= t.min && n <= t.max) ?? STREAK_TIERS[0];

export function BettingPanel({
  phase,
  winner,
  onChainGameId,
  bettingOpen = false,
  bettingTimer = 0,
  bettingOpensIn = 0,
  odds,
  streak,
}: BettingPanelProps) {
  const account = useCurrentAccount();
  const address = account?.address;
  const isConnected = !!account;
  const suiClient = useSuiClient();

  // ── Direct signing (bypasses wallet dry-run) ──
  const keypair = useMemo(() => getKeypairFromEnv(), []);
  const directExec = async (tx: Transaction) => {
    const sender = keypair!.toSuiAddress();
    tx.setSenderIfNotSet(sender);
    // @mysten/sui's builder auto-selects SUI for gas, but OneChain uses OCT.
    // Manually fetch OCT coins and set them as gas payment.
    const { data: gasCoins } = await (suiClient as any).getCoins({
      owner: sender,
      coinType: "0x2::oct::OCT",
    });
    if (!gasCoins?.length) throw new Error("No OCT gas coins found for sender");
    tx.setGasPayment(
      gasCoins.slice(0, 3).map((c: any) => ({
        objectId: c.coinObjectId,
        version: c.version,
        digest: c.digest,
      })),
    );
    tx.setGasBudgetIfNotSet(10_000_000); // 0.01 OCT max gas
    const bytes = await tx.build({ client: suiClient as any });
    const { bytes: b64bytes, signature } =
      await keypair!.signTransaction(bytes);
    return (suiClient as any).executeTransactionBlock({
      transactionBlock: b64bytes,
      signature,
      options: { showEffects: true },
    });
  };

  // ── Network detection ──
  // OneWallet validates txs against its OWN configured RPC.
  // If the account is on mainnet and the contract is on testnet, it throws
  // "Package not found". Detect this and show a clear warning.
  const accountChains: string[] = (account as any)?.chains ?? [];

  const isOnTestnet =
    accountChains.length === 0 || // unknown → don't block
    accountChains.some(
      (c) => c.toLowerCase().includes("testnet") || c.includes("1bd5c965"),
    );
  const wrongNetworkWarning = isConnected && !isOnTestnet;

  // ── OCT balance ──
  const { data: balanceData } = useSuiClientQuery(
    "getBalance",
    { owner: address ?? "", coinType: "0x2::oct::OCT" },
    { enabled: !!address, refetchInterval: 10000 },
  );
  const suiBalance = BigInt(balanceData?.totalBalance ?? 0);

  // ── On-chain game object (for payout calculation) ──
  const { data: gameObject } = useSuiClientQuery(
    "getObject",
    { id: onChainGameId ?? "", options: { showContent: true } },
    { enabled: !!onChainGameId, refetchInterval: 10000 },
  );

  // ── Sui events: on-chain bet status ──
  const userBet = useUserBet(onChainGameId, address);

  // ── Unclaimed payouts from past games ──
  const unclaimed = useUnclaimedPayouts(address);

  // ── UI state ──
  const [selectedTeam, setSelectedTeam] = useState<BetTeam>(null);
  const [amount, setAmount] = useState("");
  const [claimingGameId, setClaimingGameId] = useState<string | null>(null);
  const [claimedGameIds, setClaimedGameIds] = useState<Set<string>>(new Set());
  const [showCurrentSuccess, setShowCurrentSuccess] = useState(false);
  const [showHistSuccess, setShowHistSuccess] = useState<string | null>(null);
  const [histDirectError, setHistDirectError] = useState<string | null>(null);

  // ── optimistic pending state ──
  const [pendingBetTeam, setPendingBetTeam] = useState<BetTeam>(null);
  const [pendingBetAmount, setPendingBetAmount] = useState<string>("");
  // Track async tx preparation so button disables immediately on click
  const [isPreparing, setIsPreparing] = useState(false);
  // For direct-signing path: flag that tx was submitted (mirrors isPlaceBetSuccess)
  const [betJustPlaced, setBetJustPlaced] = useState(false);

  // ── placeBet tx ──
  const {
    mutate: executePlaceBet,
    isPending: isPlaceBetPending,
    isSuccess: isPlaceBetSuccess,
    error: placeBetError,
  } = useSignAndExecuteTransaction();

  // ── claim state (all claims use directExec automatically) ──
  const [isClaimPending, setIsClaimPending] = useState(false);
  const [isClaimSuccess, setIsClaimSuccess] = useState(false);
  const [claimError, setClaimError] = useState<Error | null>(null);
  const [isHistClaimPending, setIsHistClaimPending] = useState(false);
  const [histClaimError, setHistClaimError] = useState<Error | null>(null);

  // (historical claim success is handled inline in claimHistorical)

  // Auto-dismiss current game claim success
  useEffect(() => {
    if (isClaimSuccess) {
      setShowCurrentSuccess(true);
      const t = setTimeout(() => setShowCurrentSuccess(false), 5000);
      return () => clearTimeout(t);
    }
  }, [isClaimSuccess]);

  // Reset UI when new lobby starts
  useEffect(() => {
    if (bettingOpen && !userBet.hasBet) {
      setSelectedTeam(null);
      setAmount("");
    }
  }, [bettingOpen, userBet.hasBet]);

  // Restore pending bet from localStorage on mount / game change
  useEffect(() => {
    if (!onChainGameId || !address) return;
    if (userBet.hasBet) {
      // Bet confirmed on-chain — clear any stale pending entry
      clearPendingBet(onChainGameId, address);
      return;
    }
    const saved = loadPendingBet(onChainGameId, address);
    if (saved) {
      setPendingBetTeam(saved.team);
      setPendingBetAmount(saved.amount);
      setBetJustPlaced(true);
    }
  }, [onChainGameId, address]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear pending state once on-chain event confirms the bet
  useEffect(() => {
    if (userBet.hasBet && pendingBetTeam) {
      if (onChainGameId && address) clearPendingBet(onChainGameId, address);
      setPendingBetTeam(null);
      setPendingBetAmount("");
      setBetJustPlaced(false);
    }
  }, [userBet.hasBet, pendingBetTeam, onChainGameId, address]);

  // ── Calculate estimated payout from on-chain game object ──
  const estimatedPayout = (() => {
    if (
      !gameObject ||
      !userBet.hasBet ||
      !userBet.amount ||
      userBet.winningTeam === null
    )
      return null;
    const fields = (
      gameObject.data?.content as { fields?: Record<string, unknown> }
    )?.fields;
    if (!fields) return null;
    const totalPool = BigInt(String(fields.total_pool ?? 0));
    const winningPool =
      userBet.winningTeam === 0
        ? BigInt(String(fields.crewmates_pool ?? 0))
        : BigInt(String(fields.impostors_pool ?? 0));
    if (winningPool === BigInt(0) || userBet.result !== "win") return null;
    const fee = (totalPool * BigInt(10)) / BigInt(10000); // 0.1%
    const distributable = totalPool - fee;
    const betAmount = BigInt(userBet.amount);
    return (betAmount * distributable) / winningPool;
  })();
  // ── handlers ──
  /**
   * Pre-serialize a Transaction against our OneChain RPC so the wallet receives
   * fully-resolved bytes. This prevents the wallet from calling its own
   * (potentially wrong) RPC for object resolution or simulation.
   */
  const resolveTransaction = async (tx: Transaction): Promise<Transaction> => {
    try {
      if (account?.address) tx.setSenderIfNotSet(account.address);
      const bytes = await tx.build({ client: suiClient as any });
      return Transaction.from(bytes);
    } catch (e) {
      console.warn("[BettingPanel] tx.build failed, using raw Transaction:", e);
      return tx;
    }
  };

  const handlePlaceBet = async () => {
    if (
      !selectedTeam ||
      !amount ||
      parseFloat(amount) < 0.001 ||
      parseFloat(amount) > 0.1
    )
      return;
    if (!onChainGameId) return;

    const betMist = BigInt(Math.floor(parseFloat(amount) * 1_000_000_000));
    const teamValue =
      selectedTeam === "Crewmates" ? Team.Crewmates : Team.Impostors;

    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(betMist)]);
    tx.moveCall({
      target: `${process.env.NEXT_PUBLIC_PACKAGE_ID}::game::place_bet`,
      arguments: [
        tx.object(onChainGameId),
        tx.pure.u8(teamValue),
        coin,
        tx.object(process.env.NEXT_PUBLIC_SUI_CLOCK_ID ?? "0x6"),
      ],
    });

    setPendingBetTeam(selectedTeam);
    setPendingBetAmount(amount);
    setIsPreparing(true);

    if (keypair) {
      try {
        await directExec(tx);
        // Persist so "Syncing" state survives refresh until event indexes
        if (onChainGameId && address)
          savePendingBet(onChainGameId, address, {
            team: selectedTeam,
            amount,
          });
        setBetJustPlaced(true); // triggers success/syncing UI
      } catch (e: any) {
        console.error("[BettingPanel] place_bet direct failed:", e);
        setPendingBetTeam(null);
        setPendingBetAmount("");
      } finally {
        setIsPreparing(false);
      }
    } else {
      const resolved = await resolveTransaction(tx);
      setIsPreparing(false);
      executePlaceBet(
        { transaction: resolved as any },
        {
          onSuccess: () => {
            if (onChainGameId && address)
              savePendingBet(onChainGameId, address, {
                team: selectedTeam,
                amount,
              });
            setBetJustPlaced(true);
          },
          onError: (e) => {
            console.error("[BettingPanel] place_bet failed:", e);
            setPendingBetTeam(null);
            setPendingBetAmount("");
          },
        },
      );
    }
  };

  const claimPayout = async () => {
    if (!onChainGameId || !keypair) return;
    setIsClaimPending(true);
    setClaimError(null);
    const tx = new Transaction();
    tx.moveCall({
      target: `${process.env.NEXT_PUBLIC_PACKAGE_ID}::game::claim_payout`,
      arguments: [tx.object(onChainGameId)],
    });
    try {
      await directExec(tx);
      setIsClaimSuccess(true);
      setShowCurrentSuccess(true);
      setTimeout(() => setShowCurrentSuccess(false), 5000);
      // Refresh unclaimed list so it disappears
      unclaimed.refetch();
    } catch (e: any) {
      console.error("[BettingPanel] claim direct failed:", e);
      setClaimError(e);
    } finally {
      setIsClaimPending(false);
    }
  };

  const claimHistorical = async (gameId: string) => {
    if (!keypair) return;
    setClaimingGameId(gameId);
    setHistDirectError(null);
    setIsHistClaimPending(true);
    const tx = new Transaction();
    tx.moveCall({
      target: `${process.env.NEXT_PUBLIC_PACKAGE_ID}::game::claim_payout`,
      arguments: [tx.object(gameId)],
    });
    try {
      await directExec(tx);
      setClaimedGameIds((prev) => new Set(prev).add(gameId));
      setShowHistSuccess(gameId);
      setTimeout(() => setShowHistSuccess(null), 5000);
      // Refresh unclaimed list so it disappears
      unclaimed.refetch();
    } catch (e: any) {
      console.error("[BettingPanel] hist claim direct failed:", e);
      setHistDirectError(e?.message?.slice(0, 80) ?? "Claim failed");
    } finally {
      setClaimingGameId(null);
      setIsHistClaimPending(false);
    }
  };

  const isPlacingBet = isPreparing || isPlaceBetPending;
  const betTeamLabel = teamName(userBet.team);
  const betAmountLabel = formatSui(userBet.amount ?? undefined);
  const suiBalanceFormatted = formatSui(suiBalance);
  const hasZeroSui = isConnected && suiBalance === BigInt(0);
  const canClaim =
    userBet.result === "win" && !userBet.hasClaimed && !isClaimSuccess;
  const payoutFormatted = estimatedPayout
    ? formatSui(estimatedPayout)
    : betAmountLabel;

  // Filter out already-claimed-this-session games from unclaimed list
  const visibleUnclaimed = unclaimed.payouts.filter(
    (p) => !claimedGameIds.has(p.gameId) && p.gameId !== onChainGameId,
  );
  const unclaimedCount = visibleUnclaimed.length + (canClaim ? 1 : 0);

  // ══════════════════════════════════════════════════════════════════════════
  // SHARED SECTIONS
  // ══════════════════════════════════════════════════════════════════════════

  const balanceBar = isConnected ? (
    <div className="flex justify-between items-center p-2 bg-[#0d2137]/60 rounded-sm mb-3">
      <div className="text-[7px] font-pixel text-[#a8d8ea]/50 uppercase tracking-wider">
        OCT Balance
      </div>
      <div className="text-[9px] font-pixel text-[#88d8b0] text-glow-mint">
        {suiBalanceFormatted} <span className="text-[#a8d8ea]/40">OCT</span>
      </div>
    </div>
  ) : null;

  const zeroBalanceWarning = hasZeroSui ? (
    <div className="flex items-center gap-2 p-2.5 bg-[#ffd700]/5 border border-[#ffd700]/20 rounded-sm mb-3">
      <div className="text-[7px] font-pixel text-[#ffd700]">
        You have 0 OCT. Deposit OCT to start betting.
      </div>
    </div>
  ) : null;

  const networkWarning = wrongNetworkWarning ? (
    <div className="flex items-center gap-2 p-2.5 bg-[#ff6b6b]/10 border border-[#ff6b6b]/40 rounded-sm mb-3">
      <div className="text-[7px] font-pixel text-[#ff6b6b] leading-relaxed">
        Wrong network detected. Open OneWallet → Settings → switch to{" "}
        <span className="text-[#ffd700]">OneChain Testnet</span>, then
        reconnect.
        <br />
        <span className="text-[#a8d8ea]/50 text-[6px]">
          Connected chain: {accountChains[0] ?? "unknown"}
        </span>
      </div>
    </div>
  ) : null;

  const bettingTimerBadge =
    bettingOpen && bettingTimer > 0 ? (
      <div className="flex items-center justify-between p-2 bg-[#88d8b0]/5 border border-[#88d8b0]/20 rounded-sm mb-3">
        <div className="text-[7px] font-pixel text-[#88d8b0]/60 uppercase tracking-wider">
          Betting Closes In
        </div>
        <div
          className={`text-[10px] font-pixel ${bettingTimer <= 30 ? "text-[#ff6b6b] animate-pulse text-glow-red" : "text-[#88d8b0] text-glow-mint"}`}
        >
          {formatBetTimer(bettingTimer)}
        </div>
      </div>
    ) : null;

  const claimSection = (() => {
    if (!isConnected) return null;

    return (
      <div className="mt-auto pt-3 border-t border-[#88d8b0]/20">
        <div className="flex items-center gap-2 mb-2">
          <div className="text-[7px] font-pixel text-[#ffd700] uppercase tracking-wider">
            Claim Payouts
          </div>
          {unclaimedCount > 0 && (
            <span className="relative flex h-4 min-w-[16px] items-center justify-center rounded-full bg-[#ff4444] px-1">
              <span className="text-[7px] font-pixel text-white leading-none">
                {unclaimedCount}
              </span>
              <span className="absolute inset-0 rounded-full bg-[#ff4444] animate-ping opacity-30" />
            </span>
          )}
        </div>

        <div className="space-y-2 max-h-[200px] overflow-y-auto">
          {/* Current game claim */}
          {canClaim && (
            <div className="p-2.5 bg-[#88d8b0]/5 border border-[#88d8b0]/20 rounded-sm">
              <div className="flex justify-between items-center mb-2">
                <div className="text-[7px] font-pixel text-[#a8d8ea]/50">
                  Game {onChainGameId?.slice(0, 8)}… — {teamName(userBet.team)}
                </div>
                <div className="text-[9px] font-pixel text-[#88d8b0] text-glow-mint">
                  ~{payoutFormatted}{" "}
                  <span className="text-[#a8d8ea]/40">OCT</span>
                </div>
              </div>
              <button
                onClick={claimPayout}
                disabled={isClaimPending}
                className="w-full py-2 rounded-sm text-[8px] font-pixel uppercase tracking-wider transition-all
                  bg-[#88d8b0] hover:bg-[#9de8c0] text-[#0a1628] pixel-border
                  disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isClaimPending ? "Claiming..." : "Claim Payout"}
              </button>
              {claimError && (
                <div className="text-[7px] font-pixel text-[#ff6b6b] text-center mt-1 truncate">
                  {claimError.message?.slice(0, 60)}
                </div>
              )}
            </div>
          )}

          {showCurrentSuccess && (
            <div className="p-2.5 bg-[#88d8b0]/5 border border-[#88d8b0]/20 rounded-sm text-center animate-pulse">
              <div className="text-[8px] font-pixel text-[#88d8b0]">
                Payout claimed successfully!
              </div>
            </div>
          )}

          {/* Historical unclaimed payouts */}
          {visibleUnclaimed.map((payout) => {
            const isClaiming =
              claimingGameId === payout.gameId && isHistClaimPending;
            const justClaimed = showHistSuccess === payout.gameId;

            if (justClaimed) {
              return (
                <div
                  key={payout.gameId}
                  className="p-2.5 bg-[#88d8b0]/5 border border-[#88d8b0]/20 rounded-sm text-center animate-pulse"
                >
                  <div className="text-[8px] font-pixel text-[#88d8b0]">
                    Game {payout.gameId.slice(0, 8)}… — Claimed!
                  </div>
                </div>
              );
            }

            return (
              <div
                key={payout.gameId}
                className="p-2.5 bg-[#88d8b0]/5 border border-[#88d8b0]/20 rounded-sm"
              >
                <div className="flex justify-between items-center mb-2">
                  <div className="text-[7px] font-pixel text-[#a8d8ea]/50">
                    Game {payout.gameId.slice(0, 8)}… — {teamName(payout.team)}
                  </div>
                  <div className="text-[9px] font-pixel text-[#88d8b0]">
                    {formatSui(payout.betAmount)}{" "}
                    <span className="text-[#a8d8ea]/40">OCT bet</span>
                  </div>
                </div>
                <button
                  onClick={() => claimHistorical(payout.gameId)}
                  disabled={isClaiming}
                  className="w-full py-2 rounded-sm text-[8px] font-pixel uppercase tracking-wider transition-all
                    bg-[#88d8b0] hover:bg-[#9de8c0] text-[#0a1628] pixel-border
                    disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {isClaiming ? "Claiming..." : "Claim"}
                </button>
              </div>
            );
          })}

          {(histClaimError || histDirectError) && (
            <div className="text-[7px] font-pixel text-[#ff6b6b] text-center truncate">
              {histDirectError ?? histClaimError?.message?.slice(0, 80)}
            </div>
          )}

          {unclaimedCount === 0 && !showCurrentSuccess && (
            <div className="p-2.5 bg-[#0d2137]/40 border border-[#a8d8ea]/10 rounded-sm text-center">
              <div className="text-[7px] font-pixel text-[#a8d8ea]/30">
                No unclaimed payouts
              </div>
            </div>
          )}
        </div>
      </div>
    );
  })();

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN CONTENT
  // ══════════════════════════════════════════════════════════════════════════

  // ── SYNCING: tx submitted, waiting for events to index ──
  if (
    (isPlaceBetSuccess || betJustPlaced) &&
    pendingBetTeam &&
    !userBet.hasBet
  ) {
    const syncTeamColor =
      pendingBetTeam === "Crewmates" ? "#a8d8ea" : "#ff6b6b";
    const displayAmount = pendingBetAmount || betAmountLabel;
    return (
      <div className="retro-panel p-4 flex flex-col h-full">
        {balanceBar}
        {networkWarning}
        <div className="flex-1 flex flex-col items-center justify-center gap-4">
          {/* Success checkmark + spinner */}
          <div className="relative w-14 h-14">
            <div className="absolute inset-0 rounded-full border-2 border-[#88d8b0]/20" />
            <div className="absolute inset-0 rounded-full border-2 border-t-[#88d8b0] animate-spin" />
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-[#88d8b0] text-lg">✓</span>
            </div>
          </div>
          <div className="text-[10px] font-pixel text-[#88d8b0] text-glow-mint uppercase tracking-wider">
            Bet Placed!
          </div>
          {/* Bet summary card */}
          <div
            className="w-full rounded-sm border p-3 flex flex-col items-center gap-1"
            style={{
              backgroundColor: `${syncTeamColor}12`,
              borderColor: `${syncTeamColor}50`,
            }}
          >
            <div className="text-[7px] font-pixel text-[#a8d8ea]/40 uppercase tracking-wider">
              Your Bet
            </div>
            <div
              className="text-[13px] font-pixel"
              style={{ color: syncTeamColor }}
            >
              {pendingBetTeam}
            </div>
            <div className="text-[9px] font-pixel text-[#ffd700]">
              {displayAmount} OCT
            </div>
            <div className="text-[6px] font-pixel text-[#88d8b0]/60 uppercase tracking-wider mt-0.5">
              Confirmed On-Chain ✓
            </div>
          </div>
          <div className="text-[7px] font-pixel text-[#a8d8ea]/30 text-center leading-relaxed animate-pulse">
            Syncing events...
          </div>
        </div>
        <div className="text-[7px] font-pixel text-[#a8d8ea]/20 text-center mt-2">
          {onChainGameId ? `Game ${onChainGameId.slice(0, 10)}…` : ""}
        </div>
        {claimSection}
      </div>
    );
  }

  // ── RESULT: game settled + user has bet → WIN/LOSE banner ──
  if (userBet.result && userBet.winningTeam !== null) {
    const isWin = userBet.result === "win";
    return (
      <div className="retro-panel p-4 flex flex-col h-full">
        {balanceBar}
        {bettingTimerBadge}
        {zeroBalanceWarning}
        {networkWarning}
        <div className="text-[8px] font-pixel text-[#ffd700] uppercase tracking-widest mb-3 text-glow-gold">
          On-Chain Result
        </div>
        <div
          className={`flex flex-col items-center justify-center rounded-sm p-4 ${
            isWin
              ? "bg-[#88d8b0]/10 border border-[#88d8b0]/30"
              : "bg-[#ff6b6b]/10 border border-[#ff6b6b]/30"
          }`}
        >
          <div
            className={`text-lg font-pixel mb-1 ${
              isWin
                ? "text-[#88d8b0] text-glow-mint"
                : "text-[#ff6b6b] text-glow-red"
            }`}
          >
            {isWin ? "YOU WON" : "YOU LOST"}
          </div>
          <div className="text-[8px] font-pixel text-[#a8d8ea]/60 text-center">
            You bet <span className="text-[#ffd700]">{betAmountLabel} OCT</span>{" "}
            on{" "}
            <span
              className={
                betTeamLabel === "Crewmates"
                  ? "text-[#a8d8ea]"
                  : "text-[#ff6b6b]"
              }
            >
              {betTeamLabel}
            </span>
          </div>
        </div>
        <div className="text-[7px] font-pixel text-[#a8d8ea]/30 text-center mt-2">
          Winner: {teamName(userBet.winningTeam)}
        </div>
        {claimSection}
      </div>
    );
  }

  // ── LOCKED: user bet, waiting for result ──
  if (userBet.hasBet && !bettingOpen) {
    return (
      <div className="retro-panel p-4 flex flex-col h-full">
        {balanceBar}
        {bettingTimerBadge}
        {zeroBalanceWarning}
        {networkWarning}
        <div className="text-[8px] font-pixel text-[#ffd700] uppercase tracking-widest mb-3 text-glow-gold">
          Your Prediction
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div
            className={`w-full rounded-sm border p-3 text-center ${
              betTeamLabel === "Crewmates"
                ? "bg-[#a8d8ea]/10 border-[#a8d8ea]/30"
                : "bg-[#ff6b6b]/10 border-[#ff6b6b]/30"
            }`}
          >
            <div
              className={`text-sm font-pixel ${
                betTeamLabel === "Crewmates"
                  ? "text-[#a8d8ea]"
                  : "text-[#ff6b6b]"
              }`}
            >
              {betTeamLabel}
            </div>
            <div className="text-[7px] font-pixel text-[#ffd700]/50 mt-0.5">
              LOCKED IN
            </div>
          </div>
          <div className="text-[8px] font-pixel text-[#a8d8ea]/60 text-center">
            <span className="text-[#ffd700]">{betAmountLabel} OCT</span>{" "}
            deposited
          </div>
          <div className="text-[7px] font-pixel text-[#a8d8ea]/30 text-center">
            Waiting for game to end...
          </div>
        </div>
        {claimSection}
      </div>
    );
  }

  // ── BETTING OPEN: already bet this round ──
  if (userBet.hasBet && bettingOpen) {
    return (
      <div className="retro-panel p-4 flex flex-col h-full">
        {balanceBar}
        {bettingTimerBadge}
        {zeroBalanceWarning}
        {networkWarning}
        <div className="text-[8px] font-pixel text-[#ffd700] uppercase tracking-widest mb-3 text-glow-gold">
          Bet Placed
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div
            className={`w-full rounded-sm border p-3 text-center ${
              betTeamLabel === "Crewmates"
                ? "bg-[#a8d8ea]/10 border-[#a8d8ea]/30"
                : "bg-[#ff6b6b]/10 border-[#ff6b6b]/30"
            }`}
          >
            <div
              className={`text-sm font-pixel ${
                betTeamLabel === "Crewmates"
                  ? "text-[#a8d8ea]"
                  : "text-[#ff6b6b]"
              }`}
            >
              {betTeamLabel}
            </div>
          </div>
          <div className="text-[8px] font-pixel text-[#a8d8ea]/60">
            <span className="text-[#ffd700]">{betAmountLabel} OCT</span> on the
            line
          </div>
        </div>
        {claimSection}
      </div>
    );
  }

  // ── BETTING CLOSED: user didn't bet ──
  if (!bettingOpen && !userBet.hasBet) {
    return (
      <div className="retro-panel p-4 flex flex-col h-full">
        {balanceBar}
        {zeroBalanceWarning}
        {networkWarning}
        <div className="text-[8px] font-pixel text-[#ffd700] uppercase tracking-widest mb-3 text-glow-gold">
          Bet The Agent&apos;s Team!
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-3">
          <div className="w-12 h-12 flex items-center justify-center rounded-full bg-[#ff6b6b]/10 border border-[#ff6b6b]/20">
            <span className="text-xl">🔒</span>
          </div>
          <div className="text-[10px] font-pixel text-[#ff6b6b]">
            Betting Closed
          </div>
          <div className="text-[7px] font-pixel text-[#a8d8ea]/40 text-center leading-relaxed">
            Bets can only be placed during the LOBBY phase before the game
            starts.
          </div>
          {bettingOpensIn > 0 && (
            <div className="flex items-center gap-2 p-2 bg-[#0d2137]/60 rounded-sm">
              <div className="text-[7px] font-pixel text-[#a8d8ea]/50 uppercase tracking-wider">
                Next Game In
              </div>
              <div className="text-[9px] font-pixel text-[#88d8b0] text-glow-mint">
                {formatBetTimer(bettingOpensIn)}
              </div>
            </div>
          )}
        </div>
        <div className="text-[7px] font-pixel text-[#a8d8ea]/30 text-center mt-2">
          {onChainGameId
            ? `Game ${onChainGameId.slice(0, 10)}…`
            : "Waiting for on-chain game..."}
        </div>
        {claimSection}
      </div>
    );
  }

  // ── LOBBY: place bet form ──
  return (
    <div className="retro-panel p-4 flex flex-col h-full relative overflow-visible">
      {balanceBar}
      {bettingTimerBadge}
      {zeroBalanceWarning}
      {networkWarning}

      <div className="mb-3">
        <div className="flex items-center justify-between">
          <div className="text-[8px] font-pixel text-[#ffd700] uppercase tracking-widest mb-1 text-glow-gold">
            Predict the Winner
          </div>
          {streak && streak.currentStreak > 0 && (
            <div className="flex items-center gap-1">
              <span className="text-[10px]">🔥</span>
              <span
                className="text-[8px] font-pixel"
                style={{ color: streakTier(streak.currentStreak).color }}
              >
                {streak.currentStreak}
              </span>
              <span className="text-[7px] font-pixel text-[#a8d8ea]/50">
                {streakTier(streak.currentStreak).name}
              </span>
            </div>
          )}
        </div>
        <div className="text-[7px] font-pixel text-[#a8d8ea]/40">
          Deposit OCT to place your bet
        </div>
      </div>

      {/* Team selector */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={() =>
            bettingOpen && !isPlacingBet && setSelectedTeam("Crewmates")
          }
          className={`flex-1 rounded-sm border p-2.5 text-center transition-all ${
            selectedTeam === "Crewmates"
              ? "bg-[#a8d8ea]/10 border-[#a8d8ea] shadow-[0_0_8px_rgba(168,216,234,0.3)]"
              : "bg-[#0d2137]/40 border-[#ffd700]/10 hover:border-[#a8d8ea]/50"
          } ${!bettingOpen || isPlacingBet ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <div
            className={`text-[9px] font-pixel ${selectedTeam === "Crewmates" ? "text-[#a8d8ea]" : "text-[#a8d8ea]/50"}`}
          >
            Crewmates
          </div>
          <div className="text-[7px] font-pixel text-[#a8d8ea]/40 mt-0.5">
            {odds?.crewOdds ?? "—"}x
          </div>
        </button>
        <button
          onClick={() =>
            bettingOpen && !isPlacingBet && setSelectedTeam("Impostors")
          }
          className={`flex-1 rounded-sm border p-2.5 text-center transition-all ${
            selectedTeam === "Impostors"
              ? "bg-[#ff6b6b]/10 border-[#ff6b6b] shadow-[0_0_8px_rgba(255,107,107,0.3)]"
              : "bg-[#0d2137]/40 border-[#ffd700]/10 hover:border-[#ff6b6b]/50"
          } ${!bettingOpen || isPlacingBet ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
        >
          <div
            className={`text-[9px] font-pixel ${selectedTeam === "Impostors" ? "text-[#ff6b6b]" : "text-[#ff6b6b]/50"}`}
          >
            Impostors
          </div>
          <div className="text-[7px] font-pixel text-[#ff6b6b]/40 mt-0.5">
            {odds?.impOdds ?? "—"}x
          </div>
        </button>
      </div>

      {/* Amount input */}
      <div className="mb-4">
        <label className="text-[7px] font-pixel text-[#a8d8ea]/40 uppercase tracking-wider mb-1 block">
          Amount (OCT)
        </label>
        <div className="relative">
          <input
            type="number"
            min="0.001"
            step="0.001"
            value={amount}
            onChange={(e) =>
              bettingOpen && !isPlacingBet && setAmount(e.target.value)
            }
            placeholder="0"
            disabled={!bettingOpen || isPlacingBet}
            className="w-full bg-[#0a1628] border border-[#ffd700]/20 text-white rounded-sm px-3 py-2 pr-16 text-[10px] font-pixel focus:outline-none focus:border-[#ffd700]/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[8px] font-pixel text-[#a8d8ea]/40">
            OCT
          </span>
        </div>
        <div className="text-[7px] font-pixel text-[#a8d8ea]/30 mt-1">
          Min: 0.001 OCT | Max: 0.1 OCT
        </div>
      </div>

      {/* Place bet OR Connect Wallet */}
      {isConnected ? (
        <>
          <button
            onClick={handlePlaceBet}
            disabled={
              !bettingOpen ||
              !selectedTeam ||
              !amount ||
              parseFloat(amount) < 0.001 ||
              parseFloat(amount) > 0.1 ||
              isPlacingBet ||
              !onChainGameId
            }
            className="w-full py-2.5 rounded-sm text-[8px] font-pixel uppercase tracking-wider transition-all
              bg-[#ff6b6b] hover:bg-[#ff8a8a] text-[#0a1628] pixel-border
              disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {isPlacingBet ? "Placing Bet..." : "Place Bet"}
          </button>
          {placeBetError && (
            <div className="text-[7px] font-pixel text-[#ff6b6b] text-center mt-1 break-words">
              {placeBetError?.message?.slice(0, 120)}
            </div>
          )}
        </>
      ) : (
        <div className="w-full py-2 flex justify-center">
          <ConnectButton className="text-[8px] font-pixel" />
        </div>
      )}

      <div className="mt-3 text-[7px] font-pixel text-[#a8d8ea]/30 text-center">
        {onChainGameId
          ? `Game ${onChainGameId.slice(0, 10)}…`
          : "Waiting for on-chain game..."}
      </div>

      {claimSection}
    </div>
  );
}
