/**
 * register-v3-pools.js
 * Step 4+5+6: Register discovered V3 pools, enable feeProtocol, test harvest.
 * Caches discovered pools to v3-pools-cache.json to avoid redundant RPC probing.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC        = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const PK         = process.env.PRIVATE_KEY;
const VAULT      = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V3_FACTORY = "0xDE6763A041f8Fc94CA2EE5933736F78f6D1A11c5";
const FEE_PROTOCOL = 4;
const CACHE_FILE = path.join(__dirname, "v3-pools-cache.json");

const VAULT_ABI = [
  "function version() external view returns (string)",
  "function getRegisteredV2Pairs() external view returns (address[])",
  "function getRegisteredV3Pools() external view returns (address[])",
  "function isRegisteredV3Pool(address) external view returns (bool)",
  "function addV3PoolsBatch(address[]) external",
  "function setV3PoolFeeProtocol(address[],uint8,uint8) external",
  "function harvestAndDistribute(bool) external",
];

const V2_PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function retry(fn, retries = 5, delayMs = 3000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === retries - 1) throw e;
      console.log(`  [retry ${i+1}] ${e.shortMessage || e.message} — waiting ${delayMs}ms...`);
      await sleep(delayMs);
      delayMs *= 1.5;
    }
  }
}

async function discoverPools(provider, pairs) {
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      if (Array.isArray(cached) && cached.length > 0) {
        console.log(`  Loaded ${cached.length} pools from cache (${CACHE_FILE})`);
        return cached;
      }
    } catch (e) {
      console.log("  Cache read error, rediscovering...");
    }
  }

  const tokenSet = new Set();
  const CHUNK = 15;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const results = await Promise.allSettled(
      pairs.slice(i, i + CHUNK).map(async (pair) => {
        const pc = new ethers.Contract(pair, V2_PAIR_ABI, provider);
        const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
        return [t0.toLowerCase(), t1.toLowerCase()];
      })
    );
    for (const r of results)
      if (r.status === "fulfilled") { tokenSet.add(r.value[0]); tokenSet.add(r.value[1]); }
    await sleep(200);
  }

  const tokens = Array.from(tokenSet);
  const FEE_TIERS = [500, 3000, 10000];
  const combos = [];
  for (let i = 0; i < tokens.length; i++)
    for (let j = i + 1; j < tokens.length; j++)
      for (const fee of FEE_TIERS)
        combos.push([tokens[i], tokens[j], fee]);

  const factory = new ethers.Contract(V3_FACTORY, ["function getPool(address,address,uint24) external view returns (address)"], provider);
  const pools = []; const seen = new Set();
  const CONC = 15;
  for (let i = 0; i < combos.length; i += CONC) {
    const results = await Promise.allSettled(
      combos.slice(i, i + CONC).map(([a, b, f]) => factory.getPool(a, b, f))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const addr = r.value;
        if (addr && addr !== ethers.ZeroAddress && !seen.has(addr.toLowerCase())) {
          seen.add(addr.toLowerCase()); pools.push(addr); process.stdout.write("*");
        }
      }
    }
    await sleep(100);
  }
  console.log(`\n  Found ${pools.length} V3 pools. Caching to ${CACHE_FILE}...`);
  fs.writeFileSync(CACHE_FILE, JSON.stringify(pools, null, 2));
  return pools;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PK, provider);
  const vault    = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  console.log("=======================================================");
  console.log("  Steps 4-6: Register V3 Pools + Enable Fees + Harvest");
  console.log("=======================================================");
  console.log("  Vault version: " + await vault.version());

  // Step 3: Discover / load pools
  console.log("\n-- Step 3: Discover / Load V3 pools -----------------");
  const pairs = await vault.getRegisteredV2Pairs();
  console.log("  Using " + pairs.length + " V2 pairs...");
  const pools = await discoverPools(provider, pairs);

  // Step 4: Register with retry + delay between txs
  console.log("\n-- Step 4: Register pools in vault ------------------");
  const unregistered = [];
  for (const p of pools) {
    const already = await retry(() => vault.isRegisteredV3Pool(p));
    if (!already) unregistered.push(p);
    await sleep(30);
  }
  console.log("  " + unregistered.length + " new, " + (pools.length - unregistered.length) + " already registered.");

  const CHUNK = 20;
  for (let i = 0; i < unregistered.length; i += CHUNK) {
    const chunk = unregistered.slice(i, i + CHUNK);
    await retry(async () => {
      const tx = await vault.addV3PoolsBatch(chunk);
      console.log("  Batch [" + (i+1) + "-" + Math.min(i+CHUNK, unregistered.length) + "] tx: " + tx.hash);
      const rc = await tx.wait();
      console.log("  [OK] Confirmed in block " + rc.blockNumber);
    });
    await sleep(1500);
  }
  console.log("  [OK] All pools registered.");

  // Step 5: Enable feeProtocol
  console.log("\n-- Step 5: setFeeProtocol(" + FEE_PROTOCOL + "," + FEE_PROTOCOL + ") on all pools ---");
  const rawPools = await vault.getRegisteredV3Pools();
  const allPools = Array.from(rawPools).map(addr => String(addr));
  console.log("  " + allPools.length + " pools total.");
  for (let i = 0; i < allPools.length; i += CHUNK) {
    const chunk = allPools.slice(i, i + CHUNK);
    await retry(async () => {
      const tx = await vault.setV3PoolFeeProtocol(chunk, FEE_PROTOCOL, FEE_PROTOCOL);
      console.log("  Batch [" + (i+1) + "-" + Math.min(i+CHUNK, allPools.length) + "] tx: " + tx.hash);
      const rc = await tx.wait();
      console.log("  [OK] Confirmed in block " + rc.blockNumber);
    });
    await sleep(1500);
  }
  console.log("  [OK] feeProtocol enabled on all pools.");

  // Step 6: Test harvest
  console.log("\n-- Step 6: harvestAndDistribute() test --------------");
  await retry(async () => {
    const tx = await vault.harvestAndDistribute(true);
    console.log("  Tx: " + tx.hash);
    const receipt = await tx.wait();
    console.log("  [OK] Confirmed in block " + receipt.blockNumber);
  });

  const finalPools = await vault.getRegisteredV3Pools();
  console.log("\n=======================================================");
  console.log("  ALL DONE");
  console.log("=======================================================");
  console.log("  Vault:               " + VAULT);
  console.log("  Version:             " + await vault.version());
  console.log("  V3 factory owner:    vault (on-chain)");
  console.log("  V2 pairs registered: " + pairs.length);
  console.log("  V3 pools registered: " + finalPools.length);
  console.log("  feeProtocol:         " + FEE_PROTOCOL + " (25% of every V3 swap → vault)");
  console.log("  harvestAndDistribute: LIVE ✓");
  console.log("=======================================================");
}

main().catch((e) => { console.error("\n[FATAL]", e.message); process.exit(1); });
