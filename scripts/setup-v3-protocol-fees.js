/**
 * setup-v3-protocol-fees.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Automated V3 Protocol Fee Setup — NO frontend dependency, NO manual steps.
 *
 * How Uniswap V3 protocol fees work:
 *   - Each pool has a feeProtocol slot: (feeProtocol0, feeProtocol1) packed as uint8
 *   - feeProtocol = N means 1/N of every swap fee goes to the factory owner
 *   - Valid values: 0 (disabled) or 4–10 (meaning 1/4 = 25% ... 1/10 = 10%)
 *   - Only the factory OWNER can call pool.setFeeProtocol() and pool.collectProtocol()
 *
 * This script:
 *   1. Discovers ALL pools by scanning PoolCreated events from the V3 factory
 *   2. Calls setFeeProtocol(4, 4) on every pool → 1/4 (25%) of swap fees → protocol
 *   3. Calls collectProtocol(vault, max, max) on every pool → pulls fees to vault
 *
 * Run:
 *   node scripts/setup-v3-protocol-fees.js           (enable + collect)
 *   node scripts/setup-v3-protocol-fees.js --collect  (collect only, no enable)
 *   node scripts/setup-v3-protocol-fees.js --check    (read-only status check)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require("dotenv").config();
const { ethers } = require("ethers");

// ── Config ────────────────────────────────────────────────────────────────────
const RPC         = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const PRIVATE_KEY = process.env.PRIVATE_KEY;  // local forks only: the V3 factory owner is the vault, administered by the Safe

const V3_FACTORY  = "0xDE6763A041f8Fc94CA2EE5933736F78f6D1A11c5";
const VAULT       = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";

// 1/4 = 25% of each pool's swap fees → protocol (vault)
// Valid range: 4–10. Use 4 for maximum protocol capture.
const FEE_PROTOCOL = 4;

// ── ABIs ──────────────────────────────────────────────────────────────────────
const FACTORY_ABI = [
  "function owner() external view returns (address)",
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
];

const POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function protocolFees() external view returns (uint128 token0, uint128 token1)",
  "function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external",
  "function collectProtocol(address recipient, uint128 amount0Requested, uint128 amount1Requested) external returns (uint128 amount0, uint128 amount1)",
];

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
];

const MAX128 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Discover all V3 pools via getPool() on known token pairs ─────────────────
// Caldera getLogs times out on 39M+ blocks. Instead: extract all unique tokens
// from the vault's registered V2 pairs, then probe every combination × 3 fee
// tiers directly via factory.getPool(). Fast and reliable.
async function discoverAllPools(factory, provider) {
  console.log("  Discovering pools via factory.getPool() on known token pairs...");

  const VAULT_ABI_MIN = [
    "function getRegisteredV2Pairs() external view returns (address[])",
  ];
  const V2_PAIR_ABI = [
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
  ];
  const FACTORY_GETPOOL_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  ];
  const FEE_TIERS = [500, 3000, 10000];

  // Step 1: get all registered V2 pairs from vault
  const vault = new ethers.Contract(VAULT, VAULT_ABI_MIN, provider);
  const pairs = await vault.getRegisteredV2Pairs();
  console.log(`  Using ${pairs.length} V2 pairs to extract token universe...`);

  // Step 2: collect unique tokens from each pair
  const tokenSet = new Set();
  for (const pair of pairs) {
    try {
      const pc = new ethers.Contract(pair, V2_PAIR_ABI, provider);
      const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
      tokenSet.add(t0.toLowerCase());
      tokenSet.add(t1.toLowerCase());
    } catch (_) {}
  }
  const tokens = Array.from(tokenSet);
  console.log(`  Unique tokens found: ${tokens.length}`);

  // Step 3: probe every (tokenA, tokenB, fee) combination
  const factoryGP = new ethers.Contract(V3_FACTORY, FACTORY_GETPOOL_ABI, provider);
  const pools = [];
  const seen = new Set();

  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (const fee of FEE_TIERS) {
        try {
          const poolAddr = await factoryGP.getPool(tokens[i], tokens[j], fee);
          if (poolAddr && poolAddr !== ethers.ZeroAddress && !seen.has(poolAddr.toLowerCase())) {
            seen.add(poolAddr.toLowerCase());
            const [t0, t1] = tokens[i] < tokens[j] ? [tokens[i], tokens[j]] : [tokens[j], tokens[i]];
            pools.push({ address: poolAddr, token0: t0, token1: t1, fee });
            process.stdout.write("*");
          }
        } catch (_) {}
      }
    }
  }
  console.log(`\n  Found ${pools.length} V3 pools.`);
  return pools;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args     = process.argv.slice(2);
  const checkOnly = args.includes("--check");
  const collectOnly = args.includes("--collect");

  const provider = new ethers.JsonRpcProvider(RPC);

  if (!PRIVATE_KEY && !checkOnly) {
    console.error("PRIVATE_KEY not set in .env");
    process.exit(1);
  }

  const wallet  = checkOnly ? null : new ethers.Wallet(PRIVATE_KEY, provider);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, wallet || provider);

  const owner = await factory.owner();
  console.log("=======================================================");
  console.log("  V3 Protocol Fee Setup — Automated");
  console.log("=======================================================");
  console.log("  V3 Factory:     " + V3_FACTORY);
  console.log("  Factory owner:  " + owner);
  console.log("  Vault (recipient): " + VAULT);
  if (!checkOnly) console.log("  Wallet:         " + wallet.address);
  console.log("  feeProtocol:    " + FEE_PROTOCOL + " (1/" + FEE_PROTOCOL + " = " + Math.round(100/FEE_PROTOCOL) + "% of pool swap fees → protocol)");
  console.log("=======================================================\n");

  if (!checkOnly && wallet.address.toLowerCase() !== owner.toLowerCase()) {
    console.error("[ERR] Wallet " + wallet.address + " is NOT the factory owner!");
    console.error("      Factory owner is: " + owner);
    console.error("      setFeeProtocol() and collectProtocol() require the factory owner.");
    process.exit(1);
  }

  // Discover all pools
  const pools = await discoverAllPools(factory, provider);
  if (pools.length === 0) {
    console.log("  No pools found yet. Done.");
    return;
  }

  // Process each pool
  let enabledCount = 0;
  let collectedCount = 0;
  let totalCollected = {};

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const pool = new ethers.Contract(p.address, POOL_ABI, wallet || provider);

    // Get token symbols for display
    let sym0 = p.token0.slice(0, 6);
    let sym1 = p.token1.slice(0, 6);
    try {
      const t0 = new ethers.Contract(p.token0, ERC20_ABI, provider);
      const t1 = new ethers.Contract(p.token1, ERC20_ABI, provider);
      [sym0, sym1] = await Promise.all([t0.symbol(), t1.symbol()]);
    } catch (_) {}

    const label = `[${i+1}/${pools.length}] ${sym0}/${sym1} (${p.fee/10000}%)`;

    // Read current state
    let slot0, protFees;
    try {
      [slot0, protFees] = await Promise.all([pool.slot0(), pool.protocolFees()]);
    } catch (e) {
      console.log(`  ${label} -> uninitialized, skip`);
      continue;
    }

    const fp0 = slot0.feeProtocol % 16;
    const fp1 = slot0.feeProtocol >> 4;
    const pending0 = protFees.token0;
    const pending1 = protFees.token1;

    console.log(`  ${label}`);
    console.log(`    feeProtocol: ${fp0}/${fp1}  |  pending: ${pending0}/${pending1}`);

    // Step A: Enable feeProtocol if not set
    if (!checkOnly && !collectOnly) {
      const alreadySet = fp0 === FEE_PROTOCOL && fp1 === FEE_PROTOCOL;
      if (alreadySet) {
        console.log(`    [OK] feeProtocol already ${FEE_PROTOCOL}/${FEE_PROTOCOL}`);
      } else {
        try {
          const tx = await pool.setFeeProtocol(FEE_PROTOCOL, FEE_PROTOCOL);
          console.log(`    setFeeProtocol tx: ${tx.hash}`);
          await tx.wait();
          console.log(`    [OK] feeProtocol enabled`);
          enabledCount++;
        } catch (e) {
          console.log(`    [WARN] setFeeProtocol failed: ${e.shortMessage || e.message}`);
        }
      }
    }

    // Step B: Collect accumulated protocol fees → vault
    if (!checkOnly && (pending0 > 1n || pending1 > 1n)) {
      try {
        const tx = await pool.collectProtocol(VAULT, MAX128, MAX128);
        console.log(`    collectProtocol tx: ${tx.hash}`);
        const receipt = await tx.wait();
        // Parse CollectProtocol event for amounts
        collectedCount++;
        console.log(`    [OK] Fees collected to vault`);
      } catch (e) {
        console.log(`    [WARN] collectProtocol failed: ${e.shortMessage || e.message}`);
      }
    } else if (!checkOnly) {
      console.log(`    [INFO] No protocol fees to collect yet`);
    }

    await sleep(100);
  }

  console.log("\n=======================================================");
  console.log("  V3 Protocol Fee Setup Complete");
  console.log("=======================================================");
  if (!checkOnly) {
    console.log("  Pools with feeProtocol enabled: " + enabledCount + " newly set");
    console.log("  Pools with fees collected:      " + collectedCount);
    console.log("  All fees sent to vault:         " + VAULT);
  }
  console.log("\n  Going forward: Run with --collect to sweep fees on a schedule.");
  console.log("  Add to keeper cron: node scripts/setup-v3-protocol-fees.js --collect");
  console.log("=======================================================");
}

main().catch((e) => { console.error("[FATAL]", e.message); process.exit(1); });
