/**
 * apply-wrapper-entrypoint.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Points AGGFlowPointsWrapper at the fee-enforcing entrypoint.
 *
 * The wrapper (0xF664…59D) is what the frontend actually calls: it records Lit
 * Diamonds and applies the NFT staking multiplier, then forwards the swap to an
 * inner entrypoint. Swapping that inner entrypoint here — rather than repointing
 * the frontend — keeps the points system intact while making the 0.05% protocol
 * fee enforceable on-chain.
 *
 * The old inner entrypoint takes feeCollector and feeBps straight from calldata,
 * so any caller can set feeBps to 0 and pay the protocol nothing. Verified live:
 * the same swap returns MORE output with feeBps=0 against the old entrypoint.
 *
 * Rollback is the same script with NEW_ENTRYPOINT set to the previous address.
 *
 *   npx hardhat run scripts/apply-wrapper-entrypoint.js --network litvm
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const { ethers } = require("hardhat");

const WRAPPER = process.env.AGG_WRAPPER || "0xF664B56933f3cF0d7d69982b5A8eC9101b80059D";
const TARGET = process.env.NEW_ENTRYPOINT || "0x5E19EB2A6BA30892CCe33f93D7Fb24D498512266";
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const [signer] = await ethers.getSigners();
  const w = new ethers.Contract(WRAPPER, [
    "function entrypoint() view returns (address)",
    "function owner() view returns (address)",
    "function setEntrypoint(address) external",
  ], signer);

  const before = await w.entrypoint();
  console.log("wrapper    :", WRAPPER);
  console.log("owner      :", await w.owner());
  console.log("signer     :", signer.address);
  console.log("entrypoint :", before, "(current)");
  console.log("target     :", TARGET);

  if (before.toLowerCase() === TARGET.toLowerCase()) {
    console.log("\nAlready pointed at the target — nothing to do.");
    return;
  }

  // Never point the wrapper at something that cannot serve it: a wrong address
  // here breaks every swap on the DEX until someone notices.
  const code = await ethers.provider.getCode(TARGET);
  if (code === "0x") throw new Error(`target ${TARGET} has no code`);
  const sel = ethers.id(
    "executeSwapWithReceiver((address,uint256,address,uint256),(address,uint256,address,uint256,bool),bytes,address)"
  ).slice(2, 10);
  const impl = "0x" + (await ethers.provider.getStorage(TARGET, IMPL_SLOT)).slice(26);
  const implCode = impl !== ethers.ZeroAddress.toLowerCase() && impl !== "0x0000000000000000000000000000000000000000"
    ? await ethers.provider.getCode(impl)
    : code;
  if (!implCode.includes(sel)) throw new Error("target does not expose executeSwapWithReceiver");
  console.log("target exposes executeSwapWithReceiver: yes");

  const tx = await w.setEntrypoint(TARGET);
  console.log("\nsetEntrypoint tx:", tx.hash);
  await tx.wait();
  console.log("confirmed. wrapper.entrypoint is now:", await w.entrypoint());

  console.log("\nRollback, if a swap ever misbehaves:");
  console.log(`  NEW_ENTRYPOINT=${before} npx hardhat run scripts/apply-wrapper-entrypoint.js --network litvm`);
}

main().then(() => process.exit(0)).catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
