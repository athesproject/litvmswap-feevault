/**
 * deploy-entrypoint.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deploys a FRESH UUPS AGGFlowEntrypoint with the protocol fee enforced on-chain.
 *
 * Why fresh rather than upgrading 0xF664…59D: that proxy's implementation was
 * not built from any source in this repo — its bytecode has no getRouter/
 * setRouter selectors, and its storage slots hold neither the router nor
 * anything the source would put there. Upgrading it would write new variables
 * over a layout nobody can see. A new proxy sidesteps that entirely.
 *
 * Defaults:
 *   requiredFeeCollector = DexFeeVault   (fee cannot be routed anywhere else)
 *   minFeeBps            = 5             (0.05% floor, cannot be zeroed)
 *
 * DRY RUN BY DEFAULT.
 *   npx hardhat run scripts/deploy-entrypoint.js --network litvm            # dry run
 *   EXECUTE=1 npx hardhat run scripts/deploy-entrypoint.js --network litvm  # deploy
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const { ethers, upgrades } = require("hardhat");

const ROUTER   = process.env.AGG_ROUTER   || "0x0624E93350bFfc5B3570589FCae68e2CaBe6c620";
const VAULT    = process.env.VAULT_ADDRESS || "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const MIN_BPS  = Number(process.env.MIN_FEE_BPS || 5); // 0.05%
const OWNER    = process.env.ENTRYPOINT_OWNER || "";
const EXECUTE  = process.argv.includes("--execute") || process.env.EXECUTE === "1";

const hr = (t) => console.log("\n" + "=".repeat(70) + "\n  " + t + "\n" + "=".repeat(70));

async function main() {
  const [signer] = await ethers.getSigners();
  const owner = OWNER || signer.address;

  hr(EXECUTE ? "DEPLOY AGGFlowEntrypointUpgradeable" : "DEPLOY AGGFlowEntrypointUpgradeable — DRY RUN");
  console.log("  deployer:             ", signer.address);
  console.log("  owner:                ", owner);
  console.log("  router:               ", ROUTER);
  console.log("  requiredFeeCollector: ", VAULT, "(DexFeeVault)");
  console.log("  minFeeBps:            ", MIN_BPS, `(${(MIN_BPS / 100).toFixed(2)}%)`);

  // Sanity-check the router before pinning it into a deployment.
  const code = await ethers.provider.getCode(ROUTER);
  if (code === "0x") throw new Error(`router ${ROUTER} has no code on this chain`);
  const sel = ethers.id("executeRoute(address,uint256,address,uint256,bytes)").slice(2, 10);
  console.log("  router code:          ", (code.length - 2) / 2, "bytes,",
    code.includes(sel) ? "executeRoute PRESENT" : "executeRoute ABSENT (!)");
  if (!code.includes(sel)) throw new Error("router does not expose executeRoute — refusing to deploy against it");

  if (!EXECUTE) {
    console.log("\n  [DRY RUN] would deploy a UUPS proxy + implementation and initialize with the values above.");
    console.log("  Re-run with -- --execute to deploy.");
    return;
  }

  const Entry = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable");
  const proxy = await upgrades.deployProxy(Entry, [owner, ROUTER, VAULT, MIN_BPS], {
    kind: "uups", initializer: "initialize",
  });
  await proxy.waitForDeployment();

  const addr = await proxy.getAddress();
  const impl = await upgrades.erc1967.getImplementationAddress(addr);

  hr("DEPLOYED");
  console.log("  proxy (use this):     ", addr);
  console.log("  implementation:       ", impl);
  console.log("  version:              ", await proxy.version());
  console.log("  owner:                ", await proxy.owner());
  console.log("  router:               ", await proxy.getRouter());
  console.log("  requiredFeeCollector: ", await proxy.requiredFeeCollector());
  console.log("  minFeeBps:            ", (await proxy.minFeeBps()).toString());

  console.log("\n  Next: point the frontend at the new entrypoint —");
  console.log("    flipswap/constants/addresses.js  ->  aggregatorEntrypoint: '" + addr + "'");
  console.log("    dex-fee-vault-frontend/src/config/contracts.js -> aggregatorEntrypoint: '" + addr + "'");
  console.log("\n  Until the frontend is switched, swaps keep using the old entrypoint.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n[FATAL]", e.message); process.exit(1); });
