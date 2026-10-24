/**
 * fix-v2-feeto.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Historical setup tool (2026): the one-time V2 feeTo fix. On LitVM every role is
 * now held by the Safe, so use this only against a local fork.
 *
 * The problem it solved:
 *   feeToSetter = 0x48234eD645676b794a4CbC7483513e58cB04e22E and the vault owner
 *   were different wallets, so it could not be done with one key.
 *
 * This script does BOTH steps:
 *   Step A: signs from feeToSetter wallet → setFeeTo(vault)
 *   Step B: signs from feeToSetter wallet → setFeeToSetter(vaultOwner)
 *           (hands over control to vault-owner wallet permanently)
 *
 * After running this ONCE:
 *   - V2 protocol fees (0.05%) flow to vault on every swap — AUTOMATIC
 *   - feeToSetter is now vault-owner, so no 2-wallet dependency ever again
 *
 * Usage (local fork only, test keys):
 *   V2_FEE_TO_SETTER_KEY and PRIVATE_KEY from .env, then
 *   node scripts/fix-v2-feeto.js
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const { ethers } = require("ethers");

const RPC                 = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const VAULT_OWNER_KEY     = process.env.PRIVATE_KEY;              // local forks only: LitVM admin goes through the Safe
const FEE_TO_SETTER_KEY   = process.env.V2_FEE_TO_SETTER_KEY;    // local forks only: the V2 feeToSetter is the Safe

const V2_FACTORY = "0x4680BCe1632824d30D2F53656dD610736c3e312e";
const VAULT      = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";

const FACTORY_ABI = [
  "function feeTo() external view returns (address)",
  "function feeToSetter() external view returns (address)",
  "function setFeeTo(address) external",
  "function setFeeToSetter(address) external",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  if (!FEE_TO_SETTER_KEY) {
    console.error("=========================================");
    console.error("  [ERR] V2_FEE_TO_SETTER_KEY not set.");
    console.error("=========================================");
    console.error("  Add to .env:");
    console.error("  V2_FEE_TO_SETTER_KEY=<private key of 0x48234eD645676b794a4CbC7483513e58cB04e22E>");
    console.error("\n  This is a ONE-TIME fix. After running:");
    console.error("  - V2 protocol fees auto-flow to vault forever");
    console.error("  - feeToSetter transfers to vault-owner key (no 2-wallet dependency)");
    process.exit(1);
  }

  const setterWallet = new ethers.Wallet(FEE_TO_SETTER_KEY, provider);
  const ownerWallet  = VAULT_OWNER_KEY ? new ethers.Wallet(VAULT_OWNER_KEY, provider) : null;
  const factory      = new ethers.Contract(V2_FACTORY, FACTORY_ABI, setterWallet);

  const [currentFeeTo, currentSetter] = await Promise.all([
    factory.feeTo(),
    factory.feeToSetter(),
  ]);

  console.log("=======================================================");
  console.log("  V2 Factory — One-Time feeTo Fix");
  console.log("=======================================================");
  console.log("  V2 Factory:     " + V2_FACTORY);
  console.log("  feeToSetter:    " + currentSetter);
  console.log("  Setter wallet:  " + setterWallet.address);
  console.log("  Current feeTo:  " + currentFeeTo);
  console.log("  Target feeTo:   " + VAULT);
  if (ownerWallet) {
    console.log("  New setter:     " + ownerWallet.address + " (vault owner)");
  }
  console.log("=======================================================\n");

  if (currentSetter.toLowerCase() !== setterWallet.address.toLowerCase()) {
    console.error("[ERR] V2_FEE_TO_SETTER_KEY does not match feeToSetter on-chain!");
    console.error("      on-chain feeToSetter: " + currentSetter);
    console.error("      key resolves to:      " + setterWallet.address);
    process.exit(1);
  }

  // Step A: setFeeTo(vault)
  if (currentFeeTo.toLowerCase() === VAULT.toLowerCase()) {
    console.log("-- Step A: [ALREADY DONE] feeTo = vault");
  } else {
    console.log("-- Step A: setFeeTo(vault) ---------------------------");
    const tx = await factory.setFeeTo(VAULT);
    console.log("  Tx: " + tx.hash);
    await tx.wait();
    const newFeeTo = await factory.feeTo();
    console.log("  [OK] feeTo is now: " + newFeeTo);
  }

  // Step B: setFeeToSetter(vaultOwner) — hand over to single-key control
  if (ownerWallet && currentSetter.toLowerCase() !== ownerWallet.address.toLowerCase()) {
    console.log("-- Step B: setFeeToSetter(vaultOwner) ---------------");
    const tx2 = await factory.setFeeToSetter(ownerWallet.address);
    console.log("  Tx: " + tx2.hash);
    await tx2.wait();
    const newSetter = await factory.feeToSetter();
    console.log("  [OK] feeToSetter is now: " + newSetter);
    console.log("  [OK] All V2 Factory control consolidated to vault-owner key.");
  } else if (ownerWallet) {
    console.log("-- Step B: [ALREADY DONE] feeToSetter = vault-owner");
  } else {
    console.log("-- Step B: SKIPPED (PRIVATE_KEY not set — feeToSetter NOT transferred)");
    console.log("  You still hold feeToSetter with 0x48234e... indefinitely.");
  }

  // Final state
  const [finalFeeTo, finalSetter] = await Promise.all([
    factory.feeTo(),
    factory.feeToSetter(),
  ]);
  console.log("\n=======================================================");
  console.log("  Final State");
  console.log("=======================================================");
  console.log("  feeTo:       " + finalFeeTo + (finalFeeTo.toLowerCase() === VAULT.toLowerCase() ? " [VAULT OK]" : " [NOT VAULT]"));
  console.log("  feeToSetter: " + finalSetter);
  console.log("\n  V2 protocol fees now ACCRUE to the vault on every mint/burn —");
  console.log("  but they accrue as PAIR LP TOKENS, not as underlying tokens.");
  console.log("  setFeeTo alone does not make them spendable.");
  console.log("");
  console.log("  To turn that LP into real revenue the vault must be on v2.6+ and");
  console.log("  redeem it (transfer LP to the pair, then pair.burn):");
  console.log("    npx hardhat run scripts/upgrade.js --network litvm");
  console.log("    npx hardhat run scripts/fix-all-earnings.js --network litvm");
  console.log("  The keeper then redeems automatically every cycle.");
  console.log("=======================================================");
}

main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
