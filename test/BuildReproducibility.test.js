const { expect } = require("chai");
const { artifacts, ethers } = require("hardhat");

/**
 * A clean checkout must build exactly the code the Safe deploys (plan/litvm-team-audit-triage.md, W5, ATH-05).
 * The hashes are those of the Safe transaction at nonce 6 (multisig/ops/audit/audit-fixes-proposal.json); any
 * change to the contracts, the compiler settings or the OpenZeppelin version changes them, and then this test and
 * the Safe proposal must be renewed together.
 */
describe("Reproducible build", function () {
  const expected = {
    DexFeeVaultUpgradeable: "0xaa61faa6388033ef2337287650c8944c9cb8fae51a578de5b6730ccc1c7b7940", // 2.9.0
    AggregatorEntrypoint: "0xfbbc0ff2a17220070be91908dbff1a88a5226fd73d7cdfccf996117354e0813a", // 2.0.0
  };
  for (const [name, hash] of Object.entries(expected)) {
    it(`${name} init code hash is ${hash.slice(0, 10)}…`, async function () {
      const { bytecode } = await artifacts.readArtifact(name);
      expect(ethers.keccak256(bytecode)).to.equal(hash);
    });
  }
});
