/**
 * upgrade-and-setup-v3.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Upgrades vault to v2.2, transfers V3 factory ownership to the vault,
 * discovers all V3 pools, enables feeProtocol, and registers them.
 *
 * After this: harvestAndDistribute() handles EVERYTHING on-chain. No scripts,
 * no block scanning, no external calls — fully automated.
 *
 * Run ONCE:
 *   npx hardhat run scripts/upgrade-and-setup-v3.js --network litvm
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const { ethers, upgrades } = require("hardhat");

const VAULT_PROXY  = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V3_FACTORY   = "0xDE6763A041f8Fc94CA2EE5933736F78f6D1A11c5";
const V2_FACTORY   = "0x4680BCe1632824d30D2F53656dD610736c3e312e";

// 1/4 of every swap fee → protocol (vault). Valid: 4–10.
const FEE_PROTOCOL = 4;

const V3_FACTORY_ABI = [
  "function owner() external view returns (address)",
  "function setOwner(address) external",
];
const V3_POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function fee() external view returns (uint24)",
  "function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)",
  "function protocolFees() external view returns (uint128,uint128)",
  "function setFeeProtocol(uint8,uint8) external",
];
const V2_FACTORY_ABI = [
  "function allPairsLength() external view returns (uint256)",
  "function allPairs(uint256) external view returns (address)",
];
const V2_PAIR_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
];
const VAULT_ABI = [
  "function version() external view returns (string)",
  "function getRegisteredV2Pairs() external view returns (address[])",
  "function addV3Pool(address) external",
  "function addV3PoolsBatch(address[]) external",
  "function setV3PoolFeeProtocol(address[],uint8,uint8) external",
  "function getRegisteredV3Pools() external view returns (address[])",
  "function isRegisteredV3Pool(address) external view returns (bool)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function discoverV3Pools(signer) {
  const provider = signer.provider;
  const v2Factory = new ethers.Contract(V2_FACTORY, V2_FACTORY_ABI, provider);
  const factoryGP = new ethers.Contract(V3_FACTORY, [
    "function getPool(address,address,uint24) external view returns (address)",
  ], provider);

  // Get token universe from registered V2 pairs
  const vault = new ethers.Contract(VAULT_PROXY, VAULT_ABI, provider);
  const pairs = await vault.getRegisteredV2Pairs();
  console.log(`  Using ${pairs.length} V2 pairs for token discovery...`);

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
  console.log(`  Unique tokens: ${tokens.length}`);

  const FEE_TIERS = [500, 3000, 10000];
  const pools = [];
  const seen = new Set();

  process.stdout.write("  Probing pools: ");
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) {
      for (const fee of FEE_TIERS) {
        try {
          const addr = await factoryGP.getPool(tokens[i], tokens[j], fee);
          if (addr && addr !== ethers.ZeroAddress && !seen.has(addr.toLowerCase())) {
            seen.add(addr.toLowerCase());
            pools.push(addr);
            process.stdout.write("*");
          }
        } catch (_) {}
      }
    }
    await sleep(10);
  }
  console.log(`\n  Found ${pools.length} V3 pools.`);
  return pools;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const provider   = deployer.provider;

  console.log("=======================================================");
  console.log("  Vault v2.2 Upgrade + V3 Full Automation");
  console.log("=======================================================");
  console.log("  Deployer:   " + deployer.address);
  console.log("  Vault:      " + VAULT_PROXY);
  console.log("  V3 Factory: " + V3_FACTORY);
  console.log("=======================================================\n");

  // Step 1: Upgrade vault to v2.2
  console.log("-- Step 1: Upgrading vault to v2.2 ------------------");
  const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
  const upgraded    = await upgrades.upgradeProxy(VAULT_PROXY, DexFeeVault, { kind: "uups" });
  await upgraded.waitForDeployment();
  const ver = await upgraded.version();
  console.log("  [OK] Vault upgraded. Version: " + ver);

  // Step 2: Transfer V3 factory ownership to vault
  console.log("\n-- Step 2: Transfer V3 factory owner → vault --------");
  const v3Factory = new ethers.Contract(V3_FACTORY, V3_FACTORY_ABI, deployer);
  const currentOwner = await v3Factory.owner();
  console.log("  Current V3 factory owner: " + currentOwner);

  if (currentOwner.toLowerCase() === VAULT_PROXY.toLowerCase()) {
    console.log("  [OK] Already owned by vault.");
  } else if (currentOwner.toLowerCase() === deployer.address.toLowerCase()) {
    const tx = await v3Factory.setOwner(VAULT_PROXY);
    console.log("  Tx: " + tx.hash);
    await tx.wait();
    console.log("  [OK] V3 factory owner → vault");
  } else {
    console.error("  [ERR] Deployer is not factory owner! Owner is: " + currentOwner);
    console.error("  Cannot transfer — manually call factory.setOwner(vault) from: " + currentOwner);
  }

  // Step 3: Discover all V3 pools
  console.log("\n-- Step 3: Discovering V3 pools ----------------------");
  const pools = await discoverV3Pools(deployer);

  // Step 4: Register pools in vault
  console.log("\n-- Step 4: Registering pools in vault ----------------");
  const vault = new ethers.Contract(VAULT_PROXY, VAULT_ABI, deployer);

  // Filter only unregistered
  const unregistered = [];
  for (const p of pools) {
    const already = await vault.isRegisteredV3Pool(p);
    if (!already) unregistered.push(p);
  }
  console.log(`  Registering ${unregistered.length} new pools (${pools.length - unregistered.length} already done)...`);

  // Batch register in chunks of 50
  const CHUNK = 50;
  for (let i = 0; i < unregistered.length; i += CHUNK) {
    const chunk = unregistered.slice(i, i + CHUNK);
    const tx = await vault.addV3PoolsBatch(chunk);
    console.log(`  Batch [${i+1}-${Math.min(i+CHUNK, unregistered.length)}] tx: ${tx.hash}`);
    await tx.wait();
  }
  console.log("  [OK] All pools registered.");

  // Step 5: Enable feeProtocol on all pools
  console.log("\n-- Step 5: Enabling feeProtocol(" + FEE_PROTOCOL + "," + FEE_PROTOCOL + ") on all pools ----");
  const allPools = await vault.getRegisteredV3Pools();
  console.log(`  Setting feeProtocol on ${allPools.length} pools...`);

  for (let i = 0; i < allPools.length; i += CHUNK) {
    const chunk = allPools.slice(i, i + CHUNK);
    const tx = await vault.setV3PoolFeeProtocol(chunk, FEE_PROTOCOL, FEE_PROTOCOL);
    console.log(`  Batch [${i+1}-${Math.min(i+CHUNK, allPools.length)}] tx: ${tx.hash}`);
    await tx.wait();
  }
  console.log("  [OK] feeProtocol enabled on all pools.");

  // Final summary
  const finalPools = await vault.getRegisteredV3Pools();
  console.log("\n=======================================================");
  console.log("  Complete. Full Automation Active.");
  console.log("=======================================================");
  console.log("  Vault version:         " + await upgraded.version());
  console.log("  V3 pools registered:   " + finalPools.length);
  console.log("  V3 factory owner:      " + await v3Factory.owner());
  console.log("\n  harvestAndDistribute() now handles:");
  console.log("   V2 pair skim        (feeTo=vault, 0.05% per swap)");
  console.log("   V3 LP positions     (auto via ERC-721 enumeration)");
  console.log("   V3 pool protocol    (collectProtocol on " + finalPools.length + " pools)");
  console.log("\n  Zero external scripts. Zero block scanning.");
  console.log("  Add new pools: vault.addV3Pool(poolAddress)");
  console.log("=======================================================");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("[FATAL]", e.message);
  process.exit(1);
});
