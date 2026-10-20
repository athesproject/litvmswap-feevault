/**
 * setup-v2-v3-earnings.js
 * Full setup script for V2 + V3 fee earnings into the DEX Fee Vault.
 *
 * What this script does:
 *  1. Registers ALL V2 pairs from the factory into the vault (for harvest/skim)
 *  2. Registers WETH + any other ERC-20 tokens as distribution tokens
 *  3. Confirms V3 NonfungiblePositionManager is registered
 *  4. Sets V2 feeTo to the vault (requires FEE_TO_SETTER_KEY in .env)
 *  5. Optionally runs harvestAndDistribute()
 *
 * Run:
 *   node scripts/setup-v2-v3-earnings.js
 *   node scripts/setup-v2-v3-earnings.js --setFeeTo   (needs FEE_TO_SETTER_KEY in .env)
 *   node scripts/setup-v2-v3-earnings.js --harvest
 */

require("dotenv").config();
const { ethers } = require("ethers");

const RPC               = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const PRIVATE_KEY       = process.env.PRIVATE_KEY;
const FEE_TO_SETTER_KEY = process.env.FEE_TO_SETTER_KEY;

const VAULT      = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V2_FACTORY = "0x4680BCe1632824d30D2F53656dD610736c3e312e";
const V3_MGR     = "0x1089f046B597f259BeFDC15Bf9C90E33616BA366";
const WETH       = ethers.getAddress("0x23a35f79a57c6bf5f963a8ab290076ad13e678d1");

// Add extra distribution tokens here if needed
const EXTRA_DIST_TOKENS = [];

const VAULT_ABI = [
  "function addV2Pair(address) external",
  "function addV3Manager(address) external",
  "function addDistributionToken(address) external",
  "function isRegisteredV2Pair(address) external view returns (bool)",
  "function isRegisteredV3Manager(address) external view returns (bool)",
  "function isRegisteredDistributionToken(address) external view returns (bool)",
  "function getRegisteredV2Pairs() external view returns (address[])",
  "function getRegisteredV3Managers() external view returns (address[])",
  "function getRegisteredDistributionTokens() external view returns (address[])",
  "function getOwnedV3Positions(address) external view returns (uint256[])",
  "function harvest() external",
  "function harvestAndDistribute(bool autoPush) external",
  "function totalBps() external view returns (uint16)",
  "function version() external view returns (string)",
];

const V2_FACTORY_ABI = [
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address)",
  "function feeTo() external view returns (address)",
  "function feeToSetter() external view returns (address)",
  "function setFeeTo(address) external",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function registerAll(vault, items, label, checkFn, addFn) {
  let count = 0;
  for (const item of items) {
    const already = await checkFn(item);
    if (already) { process.stdout.write("."); continue; }
    try {
      const tx = await addFn(item);
      process.stdout.write("+");
      await tx.wait();
      count++;
    } catch (e) {
      process.stdout.write("x");
      console.error(`\n  [WARN] Failed ${label} ${item}: ${e.shortMessage || e.message}`);
    }
    await sleep(150);
  }
  console.log(`\n  Done: ${count} new ${label}(s) registered.`);
}

async function main() {
  const args       = process.argv.slice(2);
  const doSetFeeTo = args.includes("--setFeeTo");
  const doHarvest  = args.includes("--harvest");

  const provider = new ethers.JsonRpcProvider(RPC);

  if (!PRIVATE_KEY) { console.error("PRIVATE_KEY not set in .env"); process.exit(1); }

  const wallet  = new ethers.Wallet(PRIVATE_KEY, provider);
  const vault   = new ethers.Contract(VAULT, VAULT_ABI, wallet);
  const factory = new ethers.Contract(V2_FACTORY, V2_FACTORY_ABI, provider);

  const [ver, totalBps, currentFeeTo, feeToSetter, pairsLen] = await Promise.all([
    vault.version(),
    vault.totalBps(),
    factory.feeTo(),
    factory.feeToSetter(),
    factory.allPairsLength(),
  ]);

  console.log("=======================================================");
  console.log("  DEX Fee Vault -- V2 + V3 Full Earnings Setup");
  console.log("=======================================================");
  console.log("  Vault:         " + VAULT);
  console.log("  Version:       " + ver + "  |  totalBps: " + totalBps + "/10000");
  console.log("  Wallet:        " + wallet.address);
  console.log("  V2 Factory:    " + V2_FACTORY);
  console.log("    feeTo:       " + currentFeeTo);
  console.log("    feeToSetter: " + feeToSetter);
  console.log("  Total V2 Pairs: " + pairsLen.toString());
  console.log("=======================================================\n");

  // Step 1: V2 feeTo
  console.log("-- Step 1: V2 feeTo (0.05% protocol fee) -----------");
  if (currentFeeTo.toLowerCase() === VAULT.toLowerCase()) {
    console.log("  [OK] feeTo already points to vault.");
  } else if (doSetFeeTo) {
    if (!FEE_TO_SETTER_KEY) {
      console.error("  [ERR] FEE_TO_SETTER_KEY not set. Add it to .env");
    } else {
      const setterWallet  = new ethers.Wallet(FEE_TO_SETTER_KEY, provider);
      const factoryWriter = new ethers.Contract(V2_FACTORY, V2_FACTORY_ABI, setterWallet);
      console.log("  Setting feeTo -> " + VAULT);
      const tx = await factoryWriter.setFeeTo(VAULT);
      console.log("  Tx: " + tx.hash);
      await tx.wait();
      console.log("  [OK] feeTo updated to: " + (await factory.feeTo()));
    }
  } else {
    console.log("  [WARN] feeTo is: " + currentFeeTo + " (not vault)");
    console.log("  ACTION: Add FEE_TO_SETTER_KEY=<privkey of " + feeToSetter + "> to .env");
    console.log("  Then run: node scripts/setup-v2-v3-earnings.js --setFeeTo\n");
  }

  // Step 2: V2 pairs
  console.log("-- Step 2: Register all V2 pairs for harvest --------");
  const total = Number(pairsLen);
  const pairs = [];
  console.log("  Fetching " + total + " pair addresses...");
  for (let i = 0; i < total; i++) {
    pairs.push(await factory.allPairs(i));
    if ((i + 1) % 20 === 0) process.stdout.write(" " + (i + 1));
  }
  console.log("\n  Registering...");
  await registerAll(vault, pairs, "V2 pair",
    (p) => vault.isRegisteredV2Pair(p),
    (p) => vault.addV2Pair(p)
  );

  // Step 3: V3 manager
  console.log("-- Step 3: V3 NonfungiblePositionManager -----------");
  const v3ok = await vault.isRegisteredV3Manager(V3_MGR);
  if (v3ok) {
    console.log("  [OK] Already registered: " + V3_MGR);
  } else {
    const tx = await vault.addV3Manager(V3_MGR);
    console.log("  Tx: " + tx.hash);
    await tx.wait();
    console.log("  [OK] V3 Manager registered!");
  }

  // Step 4: Distribution tokens
  console.log("-- Step 4: Distribution tokens ----------------------");
  const tokens = [WETH, ...EXTRA_DIST_TOKENS.map(t => ethers.getAddress(t.toLowerCase()))];
  await registerAll(vault, tokens, "distribution token",
    (t) => vault.isRegisteredDistributionToken(t),
    (t) => vault.addDistributionToken(t)
  );

  // Final state
  const [v2Pairs, v3Managers, distTokens] = await Promise.all([
    vault.getRegisteredV2Pairs(),
    vault.getRegisteredV3Managers(),
    vault.getRegisteredDistributionTokens(),
  ]);
  console.log("\n=======================================================");
  console.log("  Final Vault State");
  console.log("=======================================================");
  console.log("  Registered V2 Pairs:    " + v2Pairs.length);
  console.log("  Registered V3 Managers: " + v3Managers.join(", "));
  console.log("  Distribution Tokens:    " + distTokens.join(", "));
  for (const mgr of v3Managers) {
    const positions = await vault.getOwnedV3Positions(mgr);
    const ids = positions.map(p => p.toString()).join(", ") || "none yet";
    console.log("  V3 Positions owned:     [" + ids + "]");
  }

  // Optional harvest
  if (doHarvest) {
    console.log("\n-- Step 5: harvestAndDistribute(autoPush=true) ------");
    const tx = await vault.harvestAndDistribute(true);
    console.log("  Tx: " + tx.hash);
    const receipt = await tx.wait();
    console.log("  [OK] Confirmed in block " + receipt.blockNumber);
  } else {
    console.log("\n  Tip: Run with --harvest to trigger harvestAndDistribute() now.");
  }

  // Reminder
  const finalFeeTo = await factory.feeTo();
  if (finalFeeTo.toLowerCase() !== VAULT.toLowerCase()) {
    console.log("\n[!] PENDING: V2 Protocol Fees NOT enabled.");
    console.log("    feeToSetter: " + feeToSetter);
    console.log("    Add FEE_TO_SETTER_KEY to .env and run: node scripts/setup-v2-v3-earnings.js --setFeeTo");
  }

  console.log("\n=======================================================");
  console.log("  Setup complete!");
  console.log("=======================================================");
}

main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
