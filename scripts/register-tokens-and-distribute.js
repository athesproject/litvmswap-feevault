/**
 * register-tokens-and-distribute.js
 * Scans all active tokens from V2/V3 pools, registers them as distribution tokens
 * in the vault, executes harvestAndDistribute(), and displays all real-time earnings!
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC   = process.env.LITVM_RPC_URL || "https://liteforge.rpc.caldera.xyz/infra-partner-http";
const PK    = process.env.PRIVATE_KEY;
const VAULT = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";

const VAULT_ABI = [
  "function version() external view returns (string)",
  "function getRegisteredV2Pairs() external view returns (address[])",
  "function getRegisteredV3Pools() external view returns (address[])",
  "function getRegisteredDistributionTokens() external view returns (address[])",
  "function isRegisteredDistributionToken(address) external view returns (bool)",
  "function addDistributionToken(address) external",
  "function harvestAndDistribute(bool) external",
  "function pendingETH(address) external view returns (uint256)",
  "function pendingTokens(address,address) external view returns (uint256)",
  "function getAllBeneficiaryIds() external view returns (bytes32[])",
  "function getBeneficiary(bytes32) external view returns (tuple(bytes32 id, address wallet, uint16 bps, bool isActive, string name))",
];

const ERC20_ABI = [
  "function symbol() external view returns (string)",
  "function decimals() external view returns (uint8)",
  "function balanceOf(address) external view returns (uint256)",
];

const POOL_ABI = [
  "function token0() external view returns (address)",
  "function token1() external view returns (address)",
  "function protocolFees() external view returns (uint128 token0, uint128 token1)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet   = new ethers.Wallet(PK, provider);
  const vault    = new ethers.Contract(VAULT, VAULT_ABI, wallet);

  console.log("=======================================================");
  console.log("  Register Real Active Tokens & Trigger Live Harvest");
  console.log("=======================================================");
  console.log("  Vault: " + VAULT);

  // 1. Discover all tokens from registered V3 pools and V2 pairs
  const [v3Pools, v2Pairs] = await Promise.all([
    vault.getRegisteredV3Pools(),
    vault.getRegisteredV2Pairs(),
  ]);

  const tokenSet = new Set();
  console.log(`  Scanning ${v3Pools.length} V3 pools for active tokens...`);
  for (const p of v3Pools) {
    try {
      const pc = new ethers.Contract(p, POOL_ABI, provider);
      const [t0, t1] = await Promise.all([pc.token0(), pc.token1()]);
      tokenSet.add(t0.toLowerCase());
      tokenSet.add(t1.toLowerCase());
    } catch (_) {}
  }

  const tokens = Array.from(tokenSet);
  console.log(`  Found ${tokens.length} unique tokens.`);

  // 2. Filter valid ERC-20 tokens that have code and symbol
  const validTokens = [];
  for (const t of tokens) {
    try {
      const erc = new ethers.Contract(t, ERC20_ABI, provider);
      const [sym, dec] = await Promise.all([erc.symbol(), erc.decimals()]);
      validTokens.push({ address: t, symbol: sym, decimals: Number(dec) });
      console.log(`    Token: ${sym.padEnd(10)} ${t} (decimals: ${dec})`);
    } catch (e) {}
  }

  console.log(`\n  Registering valid tokens as distribution tokens in vault...`);
  for (const t of validTokens) {
    const isReg = await vault.isRegisteredDistributionToken(t.address);
    if (!isReg) {
      console.log(`  Adding ${t.symbol} (${t.address})...`);
      const tx = await vault.addDistributionToken(t.address);
      await tx.wait();
      console.log(`  [OK] Added ${t.symbol}`);
      await sleep(1000);
    } else {
      console.log(`  [ALREADY] ${t.symbol}`);
    }
  }

  // 3. Execute live harvestAndDistribute(false)
  console.log("\n-- Executing live harvestAndDistribute(false) --------");
  const tx = await vault.harvestAndDistribute(false);
  console.log("  Tx sent: " + tx.hash);
  const rc = await tx.wait();
  console.log("  [OK] Confirmed in block " + rc.blockNumber);

  // 4. Check partner pending earnings
  console.log("\n=======================================================");
  console.log("  Live Partner Balances & Earnings");
  console.log("=======================================================");
  const ids = await vault.getAllBeneficiaryIds();
  for (const id of ids) {
    const b = await vault.getBeneficiary(id);
    const pEth = await vault.pendingETH(b.wallet);
    console.log(`\n  Partner: ${b.name} (${b.wallet})`);
    console.log(`    Share:      ${(b.bps / 100).toFixed(2)}%`);
    console.log(`    Pending ETH: ${ethers.formatEther(pEth)} ETH`);

    // Check token earnings for this partner
    for (const t of validTokens) {
      try {
        const pTok = await vault.pendingTokens(t.address, b.wallet);
        if (pTok > 0n) {
          console.log(`    Pending ${t.symbol}: ${ethers.formatUnits(pTok, t.decimals)} ${t.symbol}`);
        }
      } catch (_) {}
    }
  }

  console.log("\n=======================================================");
  console.log("  Complete! Check the frontend Dashboard and My Earnings.");
  console.log("=======================================================");
}

main().catch((e) => {
  console.error("\n[FATAL]", e.message);
  process.exit(1);
});
