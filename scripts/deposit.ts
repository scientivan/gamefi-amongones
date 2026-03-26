/**
 * One-time script: deposit SUI into HousePool so seed_pool() can run.
 * Usage: npx ts-node scripts/deposit.ts <amount_in_sui>
 * Example: npx ts-node scripts/deposit.ts 5
 */
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromHex } from "@mysten/sui/utils";
import dotenv from "dotenv";

dotenv.config();

async function main() {
  const amountSui = parseFloat(process.argv[2] ?? "5");
  if (isNaN(amountSui) || amountSui <= 0) {
    console.error("Usage: npx ts-node scripts/deposit.ts <amount_in_sui>");
    process.exit(1);
  }
  const amountMist = BigInt(Math.floor(amountSui * 1_000_000_000));

  const privateKey = process.env.PRIVATE_KEY!;
  const packageId = process.env.PACKAGE_ID!;
  const adminCapId = process.env.ADMIN_CAP_ID!;
  const housePoolId = process.env.HOUSE_POOL_ID!;
  const rpcUrl = process.env.RPC_URL || getFullnodeUrl("testnet");

  const keypair = privateKey.startsWith("suiprivkey")
    ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(privateKey).secretKey)
    : Ed25519Keypair.fromSecretKey(fromHex(privateKey));

  const client = new SuiClient({ url: rpcUrl });

  console.log(`Depositing ${amountSui} SUI (${amountMist} MIST) into HousePool...`);
  console.log(`HousePool: ${housePoolId}`);

  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [amountMist]);
  tx.moveCall({
    target: `${packageId}::game::deposit`,
    arguments: [
      tx.object(adminCapId),
      tx.object(housePoolId),
      coin,
    ],
  });

  const result = await client.signAndExecuteTransaction({
    signer: keypair,
    transaction: tx,
    options: { showEffects: true },
  });

  if (result.effects?.status?.status === "success") {
    console.log(`✅ Deposit berhasil! Tx: ${result.digest}`);
    console.log(`HousePool sekarang punya ${amountSui} SUI untuk seed game.`);
  } else {
    console.error("❌ Deposit gagal:", result.effects?.status?.error);
  }
}

main().catch(console.error);
