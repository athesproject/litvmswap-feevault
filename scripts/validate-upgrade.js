/**
 * validate-upgrade.js — storage-layout safety gate.
 * Read-only: proves this build of each implementation is a legal UUPS successor to what is live before any
 * upgrade transaction is proposed. Run this first, every time:
 *
 *   npx hardhat run scripts/validate-upgrade.js --network litvm
 *
 * The live implementations were deployed by the Safe (CreateCall), not by the OpenZeppelin plugin, so the
 * plugin's manifest does not know them. Instead, each check first proves that the reference contract kept in
 * contracts/legacy/ is byte for byte the code running on chain (apart from the metadata hash and the
 * implementation's own address), then validates the upgrade from that reference.
 */
const { ethers, upgrades, artifacts } = require("hardhat");

const CHECKS = [
  {
    name: "fee vault",
    proxy: process.env.VAULT_PROXY || "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10",
    reference: "DexFeeVaultUpgradeableV28",
    next: "DexFeeVaultUpgradeable",
  },
  {
    name: "aggregator entrypoint",
    proxy: process.env.ENTRYPOINT_PROXY || "0x5E19EB2A6BA30892CCe33f93D7Fb24D498512266",
    reference: "AGGFlowEntrypointUpgradeable",
    next: "AggregatorEntrypoint",
  },
];

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

function stripMetadata(hex) {
  const h = hex.toLowerCase().replace(/^0x/, "");
  const metaLength = parseInt(h.slice(-4), 16);
  return h.slice(0, -(metaLength * 2 + 4));
}

async function main() {
  let failed = false;
  for (const c of CHECKS) {
    const slot = await ethers.provider.getStorage(c.proxy, IMPLEMENTATION_SLOT);
    const impl = ethers.getAddress("0x" + slot.slice(-40));
    const live = stripMetadata(await ethers.provider.getCode(impl)).split(impl.slice(2).toLowerCase()).join("0".repeat(40));
    const reference = stripMetadata((await artifacts.readArtifact(c.reference)).deployedBytecode);
    if (live !== reference) {
      console.log(`[FAIL] ${c.name}: live implementation ${impl} is not ${c.reference}; refusing to validate.`);
      failed = true;
      continue;
    }
    await upgrades.validateUpgrade(
      await ethers.getContractFactory(c.reference),
      await ethers.getContractFactory(c.next),
      { kind: "uups" },
    );
    console.log(`[OK] ${c.name}: ${impl} is ${c.reference}; ${c.next} is a compatible upgrade.`);
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error("[FAIL]", e.message); process.exit(1); });
