/**
 * simulate-upgrade-fork.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Rehearses the whole v2.6 upgrade against REAL LitVM state on a local fork.
 * Nothing touches the live chain — the fork is thrown away when the process ends.
 *
 * It answers the only question that matters before broadcasting:
 *   "does the upgrade actually recover the stranded V2 fees, and how much?"
 *
 *   FORK=1 npx hardhat run scripts/simulate-upgrade-fork.js
 * ─────────────────────────────────────────────────────────────────────────────
 */
const { ethers, upgrades, network } = require("hardhat");

const VAULT      = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const ADMIN      = "0x23D542DCEFb00b1f4268E67a0EC1EF4de0A58fe2";
const V2_FACTORY = "0x4680BCe1632824d30D2F53656dD610736c3e312e";
const V3_FACTORY = "0xde6763a041f8fc94ca2ee5933736f78f6d1a11c5";
const WNATIVE    = "0x315374AA9b5536037Cc1Efeea2439CCC0913A77e";

const hr = (t) => console.log("\n" + "=".repeat(70) + "\n  " + t + "\n" + "=".repeat(70));

async function main() {
  if (!process.env.FORK) {
    console.error("Run with FORK=1 so hardhat forks LitVM:\n  FORK=1 npx hardhat run scripts/simulate-upgrade-fork.js");
    process.exit(1);
  }

  hr("FORK SIMULATION — real LitVM state, throwaway local chain");
  const provider = ethers.provider;
  console.log("  forked at block:", await provider.getBlockNumber());

  // Take over the admin key on the fork only.
  await network.provider.request({ method: "hardhat_impersonateAccount", params: [ADMIN] });
  await network.provider.send("hardhat_setBalance", [ADMIN, "0x21e19e0c9bab2400000"]);
  const admin = await ethers.getSigner(ADMIN);

  const ABI = [
    "function version() view returns (string)",
    "function getRegisteredV2Pairs() view returns (address[])",
    "function getRegisteredV3Pools() view returns (address[])",
    "function getStreamStats() view returns (tuple(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256))",
    "function setWrappedNativeToken(address) external",
    "function setFactories(address,address) external",
    "function syncV2Pairs(uint256) external returns (uint256)",
    "function redeemV2LpTokens(address[]) external returns (uint256)",
    "function harvest() external",
  ];
  const before = new ethers.Contract(VAULT, ABI, admin);
  console.log("  live version:", await before.version());

  const pairs = await before.getRegisteredV2Pairs();
  console.log("  registered V2 pairs:", pairs.length);

  // ── snapshot the stranded LP and the tokens it would release ─────────────
  const PAIR = ["function balanceOf(address) view returns (uint256)", "function token0() view returns (address)", "function token1() view returns (address)"];
  const ERC  = ["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)"];
  const holders = [];
  for (let i = 0; i < pairs.length; i += 30) {
    const res = await Promise.all(pairs.slice(i, i + 30).map(async (p) => {
      try {
        const c = new ethers.Contract(p, PAIR, provider);
        const b = await c.balanceOf(VAULT);
        if (b === 0n) return null;
        const [t0, t1] = await Promise.all([c.token0(), c.token1()]);
        return { p, b, t0, t1 };
      } catch { return null; }
    }));
    holders.push(...res.filter(Boolean));
  }
  console.log("  pairs holding unredeemed fee LP:", holders.length);

  const touched = [...new Set(holders.flatMap(h => [h.t0.toLowerCase(), h.t1.toLowerCase()]))];
  const balBefore = {};
  for (const t of touched) {
    try { balBefore[t] = await new ethers.Contract(t, ERC, provider).balanceOf(VAULT); } catch { balBefore[t] = 0n; }
  }

  // ── upgrade on the fork ──────────────────────────────────────────────────
  hr("Upgrading proxy to v2.6 (on the fork)");
  const Factory = await ethers.getContractFactory("DexFeeVaultUpgradeable", admin);
  await upgrades.forceImport(VAULT, Factory, { kind: "uups" }).catch(() => {});
  const upgraded = await upgrades.upgradeProxy(VAULT, Factory, { kind: "uups" });
  await upgraded.waitForDeployment();
  const v = new ethers.Contract(VAULT, ABI, admin);
  console.log("  version after upgrade:", await v.version());

  // ── configure + redeem ───────────────────────────────────────────────────
  hr("Applying the fix (on the fork)");
  await (await v.setWrappedNativeToken(WNATIVE)).wait();
  console.log("  wrappedNativeToken set");
  await (await v.setFactories(V2_FACTORY, V3_FACTORY)).wait();
  console.log("  factories set");

  const syncTx = await v.syncV2Pairs(200);
  await syncTx.wait();
  console.log("  syncV2Pairs(200) ->", (await v.getRegisteredV2Pairs()).length, "pairs registered");

  let redeemed = 0;
  const list = holders.map(h => h.p);
  for (let i = 0; i < list.length; i += 25) {
    const chunk = list.slice(i, i + 25);
    const n = await v.redeemV2LpTokens.staticCall(chunk);
    const tx = await v.redeemV2LpTokens(chunk);
    const r = await tx.wait();
    redeemed += Number(n);
    console.log(`  redeemV2LpTokens(${chunk.length}) -> ${n} redeemed · gas ${r.gasUsed}`);
  }

  // ── what actually came out ───────────────────────────────────────────────
  hr(`RESULT — ${redeemed}/${holders.length} pairs redeemed`);
  let lines = 0;
  for (const t of touched) {
    let after = 0n, sym = t.slice(0, 10);
    try {
      const c = new ethers.Contract(t, ERC, provider);
      after = await c.balanceOf(VAULT);
      sym = await c.symbol().catch(() => sym);
    } catch {}
    const gained = after - (balBefore[t] || 0n);
    if (gained > 0n) {
      console.log(`  +${Number(ethers.formatEther(gained)).toLocaleString(undefined, { maximumFractionDigits: 6 })}  ${sym}`);
      lines++;
    }
  }
  if (!lines) console.log("  (no token balance increased — check the pairs list)");

  let stillStranded = 0;
  for (const h of holders) {
    try { if ((await new ethers.Contract(h.p, PAIR, provider).balanceOf(VAULT)) > 0n) stillStranded++; } catch {}
  }
  console.log(`\n  pairs still holding LP after redemption: ${stillStranded}`);
  console.log("  (fork only — the live chain is untouched)");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n[FATAL]", e.message); process.exit(1); });
