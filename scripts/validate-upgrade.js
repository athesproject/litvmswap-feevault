/**
 * validate-upgrade.js — storage-layout safety gate.
 * Read-only: proves this build of the implementation is a legal UUPS successor to what is
 * live before any upgrade transaction is broadcast. Run this first, every time.
 */
const { ethers, upgrades } = require("hardhat");

const PROXY = process.env.PROXY_ADDRESS || "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";

async function main() {
  const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
  console.log("Validating this build against the live proxy", PROXY, "...\n");
  await upgrades.validateUpgrade(PROXY, DexFeeVault, { kind: "uups" });
  console.log("[OK] Storage layout is compatible. Upgrade is safe to broadcast.");
}

main().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
