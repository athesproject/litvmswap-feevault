/**
 * apply-all-earnings.js — the broadcasting counterpart to fix-all-earnings.js.
 *
 * Kept as a separate entry point rather than an env-var prefix so the command
 * stays a plain `npx hardhat run`, and so "report" and "apply" read as two
 * visibly different commands rather than one command with a missable flag.
 *
 * Resumes across RPC failures. The LitVM endpoint 502s often, and ethers polls
 * for a submitted transaction on its own timer — a 502 there surfaces as an
 * unhandled rejection that kills the process even though the transaction landed.
 * Every step in fix-all-earnings is idempotent (cursor-paged sync, dedup-ing
 * registration, redemption that skips empty pairs), so the correct response is
 * simply to start again and let it skip what is already done.
 *
 *   npx hardhat run scripts/apply-all-earnings.js --network litvm
 */
process.env.EXECUTE = "1";
process.env.FIXALL_NO_AUTORUN = "1";

const { main } = require("./fix-all-earnings.js");

const MAX_PASSES = Number(process.env.MAX_PASSES || 8);

// ethers' background tx polling rejects outside any await we control, so the
// handler has to live at the process level.
let onTransportCrash = null;
process.on("unhandledRejection", (err) => {
  const m = (err && (err.message || String(err))) || "";
  if (onTransportCrash && /502|503|504|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|Invalid JSON-RPC|JSON-RPC|rate|fetch|network/i.test(m)) {
    onTransportCrash(err);
    return;
  }
  console.error("\n[UNHANDLED]", m);
  process.exit(1);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    if (pass > 1) console.log(`\n########## RESUMING — pass ${pass}/${MAX_PASSES} ##########\n`);
    try {
      await new Promise((resolve, reject) => {
        onTransportCrash = reject;
        main().then(resolve, reject);
      });
      console.log("\n[OK] Completed cleanly.");
      process.exit(0);
    } catch (e) {
      const m = e?.shortMessage || e?.message || String(e);
      const transport = /502|503|504|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|Invalid JSON-RPC|JSON-RPC|rate|fetch|network/i.test(m);
      if (!transport) { console.error("\n[FATAL]", m); process.exit(1); }
      console.error(`\n[transport] ${m}\n   -> re-running; completed steps are skipped.`);
      await sleep(3000);
    } finally {
      onTransportCrash = null;
    }
  }
  console.error(`\n[GAVE UP] Still not finished after ${MAX_PASSES} passes. Re-run to continue.`);
  process.exit(1);
})();
