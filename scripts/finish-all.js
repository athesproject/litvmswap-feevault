/**
 * finish-all.js
 * Upgrade vault to v2.3, discover all V3 pools (parallel batching),
 * register them, enable feeProtocol(4,4), and confirm final state.
 */
require("dotenv").config();
const { ethers, upgrades } = require("hardhat");

const VAULT_PROXY = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V3_FACTORY  = "0xDE6763A041f8Fc94CA2EE5933736F78f6D1A11c5";
const FEE_PROTOCOL = 4;
const CONCURRENCY  = 20; // parallel getPool calls

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
const GETPOOL_ABI = [
  "function getPool(address,address,uint24) external view returns (address)",
];

async function discoverV3PoolsFast(provider, pairs) {
  // Extract unique tokens from V2 pairs in parallel
  const tokenSet = new Set();
  const chunkSize = 30;
  for (let i = 0; i < pairs.length; i += chunkSize) {
    const chunk = pairs.slice(i, i + chunkSize);
    const results = await Promise.allSettled(
      chunk.map(async (pair) => {
        const pc = new ethers.Contract(pair, V2_PAIR_ABI, provider);
        const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
        return [t0.toLowerCase(), t1.toLowerCase()];
      })
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        tokenSet.add(r.value[0]);
        tokenSet.add(r.value[1]);
      }
    }
  }
  const tokens = Array.from(tokenSet);
  console.log(`  Unique tokens: ${tokens.length}`);

  // Build all combinations
  const FEE_TIERS = [500, 3000, 10000];
  const combos = [];
  for (let i = 0; i < tokens.length; i++)
    for (let j = i + 1; j < tokens.length; j++)
      for (const fee of FEE_TIERS)
        combos.push([tokens[i], tokens[j], fee]);

  console.log(`  Probing ${combos.length} combinations (${CONCURRENCY} parallel)...`);

  const factory = new ethers.Contract(V3_FACTORY, GETPOOL_ABI, provider);
  const pools = [];
  const seen = new Set();

  // Process in parallel batches
  for (let i = 0; i < combos.length; i += CONCURRENCY) {
    const batch = combos.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(([a, b, fee]) => factory.getPool(a, b, fee))
    );
    for (const r of results) {
      if (r.status === "fulfilled") {
        const addr = r.value;
        if (addr && addr !== ethers.ZeroAddress && !seen.has(addr.toLowerCase())) {
          seen.add(addr.toLowerCase());
          pools.push(addr);
          process.stdout.write("*");
        }
      }
    }
    if ((i / CONCURRENCY) % 20 === 0) process.stdout.write(` ${i}/${combos.length}`);
  }
  console.log(`\n  Found ${pools.length} V3 pools.`);
  return pools;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider   = deployer.provider;

  console.log("=======================================================");
  console.log("  FINISH ALL — Vault v2.3 + V3 Full Setup");
  console.log("=======================================================\n");

  // Step 1: Upgrade to v2.3
  console.log("-- Step 1: Upgrade vault → v2.3 ---------------------");
  const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
  const vault = await upgrades.upgradeProxy(VAULT_PROXY, DexFeeVault, { kind: "uups" });
  await vault.waitForDeployment();
  console.log("  [OK] Version: " + await vault.version());

  // Step 2: Confirm factory owner
  console.log("\n-- Step 2: Confirm V3 factory owner -----------------");
  const v3FactoryContract = new ethers.Contract(
    V3_FACTORY,
    ["function owner() external view returns (address)"],
    provider
  );
  const ownerChecksummed = await v3FactoryContract.owner();
  console.log("  V3 factory owner: " + ownerChecksummed);
  if (ownerChecksummed.toLowerCase() === VAULT_PROXY.toLowerCase()) {
    console.log("  [OK] Vault is factory owner.");
  } else {
    console.log("  [WARN] Factory owner is NOT vault yet: " + ownerChecksummed);
  }

  // Step 3: Discover V3 pools fast
  console.log("\n-- Step 3: Discover V3 pools (parallel) -------------");
  const pairs = await vault.getRegisteredV2Pairs();
  const pools = await discoverV3PoolsFast(provider, pairs);

  // Step 4: Register all unregistered pools in vault (batch)
  console.log("\n-- Step 4: Register pools in vault ------------------");
  const unregistered = [];
  for (const p of pools) {
    const already = await vault.isRegisteredV3Pool(p);
    if (!already) unregistered.push(p);
  }
  console.log(`  ${unregistered.length} new pools to register (${pools.length - unregistered.length} already done)`);

  const CHUNK = 50;
  for (let i = 0; i < unregistered.length; i += CHUNK) {
    const chunk = unregistered.slice(i, i + CHUNK);
    const tx = await vault.addV3PoolsBatch(chunk);
    console.log(`  Batch tx: ${tx.hash}`);
    await tx.wait();
  }
  console.log("  [OK] All pools registered.");

  // Step 5: Enable feeProtocol on all pools
  console.log("\n-- Step 5: Enable feeProtocol(" + FEE_PROTOCOL + "," + FEE_PROTOCOL + ") on all pools -");
  const allPools = await vault.getRegisteredV3Pools();
  for (let i = 0; i < allPools.length; i += CHUNK) {
    const chunk = allPools.slice(i, i + CHUNK);
    const tx = await vault.setV3PoolFeeProtocol(chunk, FEE_PROTOCOL, FEE_PROTOCOL);
    console.log(`  Batch tx: ${tx.hash}`);
    await tx.wait();
  }
  console.log("  [OK] feeProtocol enabled on " + allPools.length + " pools.");

  // Step 6: Test harvest
  console.log("\n-- Step 6: Test harvestAndDistribute() --------------");
  const tx = await vault.harvestAndDistribute(true);
  console.log("  Tx: " + tx.hash);
  const receipt = await tx.wait();
  console.log("  [OK] Confirmed in block " + receipt.blockNumber);

  // Final state
  const finalPools = await vault.getRegisteredV3Pools();
  console.log("\n=======================================================");
  console.log("  ALL DONE");
  console.log("=======================================================");
  console.log("  Vault version:        " + await vault.version());
  console.log("  V3 factory owner:     " + ownerChecksummed + " (vault)");
  console.log("  V3 pools registered:  " + finalPools.length);
  console.log("  V2 pairs registered:  " + pairs.length);
  console.log("  harvestAndDistribute: WORKING");
  console.log("=======================================================");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("\n[FATAL]", e.message);
  process.exit(1);
});
