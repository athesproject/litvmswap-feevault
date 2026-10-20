/**
 * fix-all-earnings.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Brings every V2 / V3 / aggregator revenue stream into the vault and keeps it
 * there. Safe to re-run: every step is idempotent and skipped when already done.
 *
 *   1. Verify the proxy is running v2.6.0+
 *   2. setWrappedNativeToken(wzkLTC)      — stop relying on the hardcoded fallback
 *   3. setFactories(v2Factory, v3Factory) — enables on-chain registry sync
 *   4. syncV2Pairs()                      — pull every factory pair into the registry
 *   5. Discover + register missing V3 pools
 *   6. setV3PoolFeeProtocol on pools sitting at feeProtocol = 0 (they earn nothing)
 *   7. redeemV2LpTokens()                 — convert stranded fee LP into real tokens
 *
 * DRY RUN BY DEFAULT. In dry-run the vault is bound to a *provider*, so the
 * script is structurally incapable of broadcasting.
 *
 *   npx hardhat run scripts/fix-all-earnings.js --network litvm            # dry run
 *   EXECUTE=1 npx hardhat run scripts/fix-all-earnings.js --network litvm  # apply
 *
 * `hardhat run` rejects a `-- --execute` passthrough (HH305), so the switch is an
 * env var. A missing flag therefore fails safe to a dry run rather than erroring.
 * ─────────────────────────────────────────────────────────────────────────────
 */
require("dotenv").config();
const { ethers } = require("hardhat");

const VAULT      = process.env.VAULT_ADDRESS || "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";
const V2_FACTORY = process.env.V2_FACTORY    || "0x4680BCe1632824d30D2F53656dD610736c3e312e";
const V3_FACTORY = process.env.V3_FACTORY    || "0xde6763a041f8fc94ca2ee5933736f78f6d1a11c5";
const WNATIVE    = process.env.WNATIVE       || "0x315374AA9b5536037Cc1Efeea2439CCC0913A77e";
const V3_MANAGER = process.env.V3_POSITION_MANAGER || "0x1089f046B597f259BeFDC15Bf9C90E33616BA366";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const FEE_PROTOCOL = Number(process.env.FEE_PROTOCOL || 4); // 4 => 25% to protocol
const FEE_TIERS    = (process.env.FEE_TIERS || "100,500,3000,10000").split(",").map(Number);
const EXECUTE      = process.argv.includes("--execute") || process.env.EXECUTE === "1";

const VAULT_ABI = [
  "function version() view returns (string)",
  "function wrappedNativeToken() view returns (address)",
  "function v2Factory() view returns (address)",
  "function v2SyncCursor() view returns (uint256)",
  "function getRegisteredV2Pairs() view returns (address[])",
  "function getRegisteredV3Pools() view returns (address[])",
  "function getRegisteredV3Managers() view returns (address[])",
  "function getRegisteredDistributionTokens() view returns (address[])",
  "function setWrappedNativeToken(address) external",
  "function setFactories(address,address) external",
  "function syncV2Pairs(uint256) external returns (uint256)",
  "function addV3PoolsBatch(address[]) external",
  "function addV3Manager(address) external",
  "function setV3PoolFeeProtocol(address[],uint8,uint8) external returns (uint256,uint256)",
  "function redeemV2LpTokens(address[]) external returns (uint256)",
];
const MC3_ABI = ["function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])"];

const I_V2F  = new ethers.Interface(["function allPairs(uint256) view returns (address)", "function allPairsLength() view returns (uint256)", "function feeTo() view returns (address)"]);
const I_V3F  = new ethers.Interface(["function getPool(address,address,uint24) view returns (address)", "function owner() view returns (address)"]);
const I_PAIR = new ethers.Interface(["function balanceOf(address) view returns (uint256)", "function token0() view returns (address)", "function token1() view returns (address)"]);
const I_POOL = new ethers.Interface(["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"]);

const hr    = (t) => console.log("\n" + "=".repeat(70) + "\n  " + t + "\n" + "=".repeat(70));
const act   = (m) => console.log(EXECUTE ? "  -> " + m : "  [DRY RUN] would " + m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The LitVM RPC intermittently 502s. A failed read must never be mistaken for
 *  "no fees here" — every read below feeds a money decision. */
async function retry(fn, tries = 7, label = "call") {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const m = e.shortMessage || e.message || "";
      if (!/502|503|504|timeout|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|socket|Invalid JSON-RPC|rate|fetch|network/i.test(m)) throw e;
      await sleep(300 * 2 ** i);
    }
  }
  throw new Error(`${label} failed after ${tries} tries: ${last?.shortMessage || last?.message}`);
}

/**
 * Takes a THUNK, never a promise. `send("x", vault.foo())` would evaluate — and
 * broadcast — the call before send() could check EXECUTE.
 */
async function send(label, txThunk) {
  if (!EXECUTE) return null;

  // Submission is retried on TRANSPORT failures only. This RPC 502s often enough
  // that a single hiccup would otherwise abandon a multi-transaction run halfway.
  // A revert is never retried — that is the chain saying no, and re-sending would
  // just burn gas. "nonce too low"/"already known" means an earlier attempt did
  // land despite the error, so we stop rather than send a duplicate.
  let tx;
  for (let attempt = 0; ; attempt++) {
    try { tx = await txThunk(); break; }
    catch (e) {
      const m = e.shortMessage || e.message || "";
      if (/nonce too low|already known|replacement transaction underpriced/i.test(m)) {
        console.log(`     ${label} ... already submitted, skipping`);
        return null;
      }
      const transport = /502|503|504|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|Invalid JSON-RPC|rate|fetch|network/i.test(m);
      if (!transport || attempt >= 5) throw e;
      process.stdout.write(`     ${label} ... transport error, retrying (${attempt + 1}/5)\n`);
      await sleep(1000 * 2 ** attempt);
    }
  }

  process.stdout.write(`     ${label} ... ${tx.hash} `);
  // Losing the receipt to a 502 does not undo the transaction, so poll for it.
  const r = await retry(() => tx.wait(), 6, `${label} receipt`);
  console.log(`(gas ${r.gasUsed.toString()})`);
  return r;
}

/** Batched eth_call via Multicall3: ~80k probes become ~200 requests. */
async function mcall(mc, calls, chunk = 400) {
  const out = [];
  for (let i = 0; i < calls.length; i += chunk) {
    const slice = calls.slice(i, i + chunk);
    const res = await retry(
      () => mc.aggregate3.staticCall(slice.map(c => [c.target, true, c.callData])),
      5, `multicall ${i}`,
    );
    out.push(...res.map((r, k) => ({ ok: r[0], data: r[1], meta: slice[k].meta })));
    if (i && i % (chunk * 10) === 0) process.stdout.write(".");
  }
  return out;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const vault = new ethers.Contract(VAULT, VAULT_ABI, EXECUTE ? signer : provider);
  const mc    = new ethers.Contract(MULTICALL3, MC3_ABI, provider);

  hr(EXECUTE ? "FIX ALL EARNINGS — EXECUTING (broadcasts transactions)"
             : "FIX ALL EARNINGS — DRY RUN (nothing is broadcast)");
  console.log("  vault: ", VAULT);
  console.log("  signer:", signer.address);

  const version = await retry(() => vault.version(), 5, "version");
  console.log("  version:", version);
  const [maj, min] = version.split(".").map(Number);
  const hasV26 = maj > 2 || (maj === 2 && min >= 6);
  if (!hasV26) {
    console.log("\n  [WARN] Vault is pre-2.6: no V2 LP redemption, no registry sync.");
    console.log("         Upgrade first: npx hardhat run scripts/upgrade.js --network litvm");
    if (EXECUTE) { console.error("\n  [STOP] Refusing to execute against a pre-2.6 vault."); process.exit(1); }
    console.log("         Continuing in report-only mode.");
  }

  // ── 2. wrapped native ────────────────────────────────────────────────────
  hr("2. Wrapped native token");
  const wNow = await retry(() => vault.wrappedNativeToken(), 5, "wrappedNativeToken");
  if (wNow.toLowerCase() === WNATIVE.toLowerCase()) console.log("  already set:", wNow);
  else {
    console.log("  currently:", wNow === ethers.ZeroAddress ? "UNSET (falling back to a hardcoded address)" : wNow);
    act(`setWrappedNativeToken(${WNATIVE})`);
    if (hasV26 || true) await send("setWrappedNativeToken", () => vault.setWrappedNativeToken(WNATIVE));
  }

  // ── 3. factories ─────────────────────────────────────────────────────────
  hr("3. Factory wiring");
  const [feeToRes, ownerRes] = await mcall(mc, [
    { target: V2_FACTORY, callData: I_V2F.encodeFunctionData("feeTo") },
    { target: V3_FACTORY, callData: I_V3F.encodeFunctionData("owner") },
  ]);
  const feeTo   = feeToRes.ok ? I_V2F.decodeFunctionResult("feeTo", feeToRes.data)[0] : "?";
  const v3owner = ownerRes.ok ? I_V3F.decodeFunctionResult("owner", ownerRes.data)[0] : "?";
  console.log("  V2 factory.feeTo:", feeTo,   feeTo.toLowerCase()   === VAULT.toLowerCase() ? "[= VAULT OK]" : "[!! NOT THE VAULT — V2 fees go elsewhere]");
  console.log("  V3 factory.owner:", v3owner, v3owner.toLowerCase() === VAULT.toLowerCase() ? "[= VAULT OK]" : "[!! NOT THE VAULT — collectProtocol will fail]");

  const facNow = hasV26 ? await retry(() => vault.v2Factory(), 5, "v2Factory") : ethers.ZeroAddress;
  if (facNow.toLowerCase() !== V2_FACTORY.toLowerCase()) {
    act(`setFactories(${V2_FACTORY}, ${V3_FACTORY})`);
    await send("setFactories", () => vault.setFactories(V2_FACTORY, V3_FACTORY));
  } else console.log("  factories already configured");

  const mgrs = await retry(() => vault.getRegisteredV3Managers(), 5, "v3 managers");
  if (!mgrs.map(m => m.toLowerCase()).includes(V3_MANAGER.toLowerCase())) {
    act(`addV3Manager(${V3_MANAGER})`);
    await send("addV3Manager", () => vault.addV3Manager(V3_MANAGER));
  } else console.log("  V3 position manager already registered");

  // ── 4. V2 registry sync ──────────────────────────────────────────────────
  hr("4. V2 pair registry sync");
  const regPairs = await retry(() => vault.getRegisteredV2Pairs(), 5, "v2 pairs");
  const totalRes = await mcall(mc, [{ target: V2_FACTORY, callData: I_V2F.encodeFunctionData("allPairsLength") }]);
  const total = Number(I_V2F.decodeFunctionResult("allPairsLength", totalRes[0].data)[0]);
  let cursor = hasV26 ? Number(await retry(() => vault.v2SyncCursor(), 5, "cursor")) : 0;
  console.log(`  factory pairs: ${total} | registered: ${regPairs.length} | cursor: ${cursor}`);

  const PAGE = Number(process.env.SYNC_PAGE || 60);
  if (cursor >= total) console.log("  registry already in sync");
  else if (!hasV26) console.log(`  [DRY RUN] upgrade would let syncV2Pairs() register ${total - regPairs.length} unregistered pair(s)`);
  else {
    console.log(`  ${total - cursor} pair(s) to scan, ${PAGE} per tx (${Math.ceil((total - cursor) / PAGE)} tx)`);
    while (cursor < total) {
      act(`syncV2Pairs(${PAGE})  [cursor ${cursor}/${total}]`);
      if (!EXECUTE) break;
      await send(`syncV2Pairs ${cursor}`, () => vault.syncV2Pairs(PAGE));
      cursor = Number(await retry(() => vault.v2SyncCursor(), 5, "cursor"));
    }
  }

  // ── all factory pairs + their tokens, in two multicall sweeps ────────────
  process.stdout.write("\n  reading factory pairs");
  const pairRes = await mcall(mc, Array.from({ length: total }, (_, i) => ({
    target: V2_FACTORY, callData: I_V2F.encodeFunctionData("allPairs", [i]),
  })));
  const allPairs = pairRes.filter(r => r.ok).map(r => I_V2F.decodeFunctionResult("allPairs", r.data)[0]);
  console.log(` -> ${allPairs.length}`);

  process.stdout.write("  reading pair tokens");
  const tokRes = await mcall(mc, allPairs.flatMap(p => ([
    { target: p, callData: I_PAIR.encodeFunctionData("token0"), meta: p },
    { target: p, callData: I_PAIR.encodeFunctionData("token1"), meta: p },
  ])));
  const tokenSet = new Set([WNATIVE.toLowerCase()]);
  for (const r of tokRes) {
    if (!r.ok) continue;
    try { tokenSet.add(ethers.getAddress("0x" + r.data.slice(26)).toLowerCase()); } catch {}
  }
  const distTokens = (await retry(() => vault.getRegisteredDistributionTokens(), 5, "dist tokens")).map(t => t.toLowerCase());
  distTokens.forEach(t => tokenSet.add(t));
  console.log(` -> ${tokenSet.size} unique token(s)`);

  // ── 5. V3 pool discovery ─────────────────────────────────────────────────
  hr("5. V3 pool discovery");
  const regPools = (await retry(() => vault.getRegisteredV3Pools(), 5, "v3 pools")).map(p => p.toLowerCase());

  // Probe anchor x everything rather than every unordered pair: a V3 pool with
  // neither the wrapped native nor a registered distribution token on one side
  // has no route into the rest of the DEX and earns nothing worth chasing.
  const anchors = [...new Set([WNATIVE.toLowerCase(), ...distTokens])];
  const others  = [...tokenSet];
  const probes  = [];
  const seen    = new Set();
  for (const a of anchors) for (const b of others) {
    if (a === b) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const fee of FEE_TIERS) probes.push({ target: V3_FACTORY, callData: I_V3F.encodeFunctionData("getPool", [a, b, fee]) });
  }
  process.stdout.write(`  probing ${probes.length} (anchor, token, fee) combination(s)`);
  const poolRes = await mcall(mc, probes);
  const found = new Set();
  for (const r of poolRes) {
    if (!r.ok) continue;
    const addr = "0x" + r.data.slice(26);
    if (addr !== ethers.ZeroAddress.toLowerCase() && /[1-9a-f]/.test(addr.slice(2))) found.add(addr.toLowerCase());
  }
  const missing = [...found].filter(p => !regPools.includes(p));
  console.log(`\n  pools found: ${found.size} | registered: ${regPools.length} | MISSING: ${missing.length}`);
  if (missing.length) {
    missing.slice(0, 10).forEach(p => console.log("    missing:", p));
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      act(`addV3PoolsBatch(${chunk.length} pools)`);
      await send("addV3PoolsBatch", () => vault.addV3PoolsBatch(chunk));
    }
  }

  // ── 6. feeProtocol ───────────────────────────────────────────────────────
  hr("6. V3 feeProtocol");
  const check = [...new Set([...regPools, ...missing])];
  const s0Res = await mcall(mc, check.map(p => ({ target: p, callData: I_POOL.encodeFunctionData("slot0"), meta: p })));
  const off = [];
  let readable = 0;
  s0Res.forEach((r) => {
    if (!r.ok) return;
    readable++;
    try {
      const fp = Number(I_POOL.decodeFunctionResult("slot0", r.data)[5]);
      if (fp === 0) off.push(r.meta);
    } catch {}
  });
  console.log(`  read ${readable}/${check.length} pool(s) | feeProtocol OFF: ${off.length}`);
  if (off.length) {
    off.slice(0, 12).forEach(p => console.log("    OFF (earning nothing):", p));
    for (let i = 0; i < off.length; i += 50) {
      const chunk = off.slice(i, i + 50);
      act(`setV3PoolFeeProtocol(${chunk.length} pools, ${FEE_PROTOCOL}, ${FEE_PROTOCOL})`);
      await send("setV3PoolFeeProtocol", () => vault.setV3PoolFeeProtocol(chunk, FEE_PROTOCOL, FEE_PROTOCOL));
    }
  } else console.log("  every pool already earns protocol fees");

  // ── 7. stranded V2 LP ────────────────────────────────────────────────────
  hr("7. Stranded V2 protocol-fee LP");
  const balRes = await mcall(mc, allPairs.map(p => ({
    target: p, callData: I_PAIR.encodeFunctionData("balanceOf", [VAULT]), meta: p,
  })));
  const withLp = [];
  for (const r of balRes) {
    if (!r.ok) continue;
    try {
      const b = I_PAIR.decodeFunctionResult("balanceOf", r.data)[0];
      if (b > 0n) withLp.push({ pair: r.meta, lp: b });
    } catch {}
  }
  withLp.sort((a, b) => (b.lp > a.lp ? 1 : -1));
  console.log(`  pairs holding unredeemed fee LP: ${withLp.length}`);
  withLp.slice(0, 12).forEach(x => console.log(`    ${x.pair}  LP=${Number(ethers.formatEther(x.lp)).toFixed(6)}`));
  if (!hasV26) {
    console.log(`\n  [DRY RUN] this LP is UNREDEEMABLE on v${version} — the upgrade is what unlocks it.`);
  } else if (withLp.length) {
    const list = withLp.map(x => x.pair);
    // Each redemption is a transfer + pair.burn, which is heavy. 25 at a time can
    // exceed the block gas limit and revert the whole batch; 8 leaves headroom.
    const REDEEM_CHUNK = Number(process.env.REDEEM_CHUNK || 8);
    for (let i = 0; i < list.length; i += REDEEM_CHUNK) {
      const chunk = list.slice(i, i + REDEEM_CHUNK);
      act(`redeemV2LpTokens(${chunk.length} pairs)`);
      await send("redeemV2LpTokens", () => vault.redeemV2LpTokens(chunk));
    }
  }

  hr(EXECUTE ? "DONE" : "DRY RUN COMPLETE — re-run with EXECUTE=1 to apply");
}

module.exports = { main };

// Auto-run when invoked directly. The apply wrapper sets this so it can drive
// main() itself and resume across the RPC's frequent 502s.
if (!process.env.FIXALL_NO_AUTORUN) {
  main().then(() => process.exit(0)).catch((e) => { console.error("\n[FATAL]", e.message); process.exit(1); });
}
