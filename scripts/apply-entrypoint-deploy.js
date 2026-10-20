/**
 * apply-entrypoint-deploy.js — deploys the fresh UUPS AGGFlowEntrypoint for real.
 * See scripts/deploy-entrypoint.js for what it does and why.
 *
 *   npx hardhat run scripts/apply-entrypoint-deploy.js --network litvm
 */
process.env.EXECUTE = "1";
require("./deploy-entrypoint.js");
