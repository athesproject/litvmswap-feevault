/**
 * report-stranded-v2.js — read-only.
 *
 * Values the V2 protocol-fee LP the vault is holding but cannot currently spend.
 * Burning LP returns a pro-rata slice of BOTH pair reserves, so the redeemable
 * amount per pair is lp * reserve / totalSupply on each leg. Where one leg is
 * wzkLTC the whole position can be priced from the pair itself; otherwise the
 * token amounts are reported raw rather than guessed at.
 */
require("dotenv").config();
const { ethers } = require("hardhat");

const VAULT      = "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V2_FACTORY = "0x4680BCe1632824d30D2F53656dD610736c3e312e";
const WNATIVE    = "0x315374AA9b5536037Cc1Efeea2439CCC0913A77e".toLowerCase();
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const I_V2F  = new ethers.Interface(["function allPairs(uint256) view returns (address)", "function allPairsLength() view returns (uint256)"]);
const I_PAIR = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const I_ERC = new ethers.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const MC3 = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function retry(fn, tries = 7) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      const m = e.shortMessage || e.message || "";
      if (!/502|503|504|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|Invalid JSON-RPC|rate|fetch|network/i.test(m)) throw e;
      await sleep(300 * 2 ** i);
    }
  }
  throw last;
}
async function mcall(mc, calls, chunk = 400) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const s = calls.slice(i, i + chunk);
    const r = await retry(() => mc.aggregate3.staticCall(s.map(c => [c.target, true, c.callData])));
    out.push(...r.map((x, k) => ({ ok: x[0], data: x[1], meta: s[k].meta })));
  }
  return out;
}
const dec = (iface, fn, d) => iface.decodeFunctionResult(fn, d);

async function main() {
  const mc = new ethers.Contract(MULTICALL3, MC3, ethers.provider);

  const lenRes = await mcall(mc, [{ target: V2_FACTORY, callData: I_V2F.encodeFunctionData("allPairsLength") }]);
  const total = Number(dec(I_V2F, "allPairsLength", lenRes[0].data)[0]);

  const pairRes = await mcall(mc, Array.from({ length: total }, (_, i) => ({
    target: V2_FACTORY, callData: I_V2F.encodeFunctionData("allPairs", [i]),
  })));
  const pairs = pairRes.filter(r => r.ok).map(r => dec(I_V2F, "allPairs", r.data)[0]);

  const balRes = await mcall(mc, pairs.map(p => ({ target: p, callData: I_PAIR.encodeFunctionData("balanceOf", [VAULT]), meta: p })));
  const held = [];
  for (const r of balRes) {
    if (!r.ok) continue;
    try { const b = dec(I_PAIR, "balanceOf", r.data)[0]; if (b > 0n) held.push({ pair: r.meta, lp: b }); } catch {}
  }

  const detail = await mcall(mc, held.flatMap(h => ([
    { target: h.pair, callData: I_PAIR.encodeFunctionData("totalSupply"), meta: { p: h.pair, k: "ts" } },
    { target: h.pair, callData: I_PAIR.encodeFunctionData("getReserves"), meta: { p: h.pair, k: "r" } },
    { target: h.pair, callData: I_PAIR.encodeFunctionData("token0"),      meta: { p: h.pair, k: "t0" } },
    { target: h.pair, callData: I_PAIR.encodeFunctionData("token1"),      meta: { p: h.pair, k: "t1" } },
  ])));
  const byPair = {};
  for (const r of detail) {
    if (!r.ok) continue;
    const { p, k } = r.meta;
    byPair[p] = byPair[p] || {};
    try {
      if (k === "ts") byPair[p].ts = dec(I_PAIR, "totalSupply", r.data)[0];
      if (k === "r")  { const x = dec(I_PAIR, "getReserves", r.data); byPair[p].r0 = x[0]; byPair[p].r1 = x[1]; }
      if (k === "t0") byPair[p].t0 = dec(I_PAIR, "token0", r.data)[0].toLowerCase();
      if (k === "t1") byPair[p].t1 = dec(I_PAIR, "token1", r.data)[0].toLowerCase();
    } catch {}
  }

  const toks = [...new Set(Object.values(byPair).flatMap(v => [v.t0, v.t1]).filter(Boolean))];
  const symRes = await mcall(mc, toks.flatMap(t => ([
    { target: t, callData: I_ERC.encodeFunctionData("symbol"),   meta: { t, k: "s" } },
    { target: t, callData: I_ERC.encodeFunctionData("decimals"), meta: { t, k: "d" } },
  ])));
  const meta = {};
  for (const r of symRes) {
    if (!r.ok) continue;
    const { t, k } = r.meta; meta[t] = meta[t] || { sym: t.slice(0, 8), dp: 18 };
    try {
      if (k === "s") meta[t].sym = dec(I_ERC, "symbol", r.data)[0];
      if (k === "d") meta[t].dp = Number(dec(I_ERC, "decimals", r.data)[0]);
    } catch {}
  }

  console.log("\n" + "=".repeat(74));
  console.log("  STRANDED V2 PROTOCOL-FEE LP — redeemable once the vault is on v2.6");
  console.log("=".repeat(74));
  console.log(`  factory pairs: ${total} | pairs holding vault LP: ${held.length}\n`);

  let wNativeTotal = 0n;
  const rows = [];
  for (const h of held) {
    const d = byPair[h.pair];
    if (!d || !d.ts || d.ts === 0n) continue;
    const a0 = (h.lp * d.r0) / d.ts;
    const a1 = (h.lp * d.r1) / d.ts;
    if (d.t0 === WNATIVE) wNativeTotal += a0;
    if (d.t1 === WNATIVE) wNativeTotal += a1;
    const m0 = meta[d.t0] || { sym: "?", dp: 18 }, m1 = meta[d.t1] || { sym: "?", dp: 18 };
    rows.push({
      pair: h.pair, lp: h.lp,
      s0: `${Number(ethers.formatUnits(a0, m0.dp)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${m0.sym}`,
      s1: `${Number(ethers.formatUnits(a1, m1.dp)).toLocaleString(undefined, { maximumFractionDigits: 4 })} ${m1.sym}`,
      hasW: d.t0 === WNATIVE || d.t1 === WNATIVE,
    });
  }
  rows.sort((a, b) => (b.lp > a.lp ? 1 : -1));
  rows.forEach((r, i) => console.log(`  ${String(i + 1).padStart(2)}. ${r.pair}  ${r.s0}  +  ${r.s1}`));

  console.log("\n" + "-".repeat(74));
  console.log(`  wzkLTC recoverable (wzkLTC legs only): ${ethers.formatEther(wNativeTotal)} wzkLTC`);
  console.log(`  ...plus the paired token on all ${rows.length} position(s), listed above.`);
  console.log(`  Pairs with a wzkLTC leg: ${rows.filter(r => r.hasW).length}/${rows.length}`);
  console.log("-".repeat(74));
}

main().then(() => process.exit(0)).catch(e => { console.error("[FATAL]", e.message); process.exit(1); });
