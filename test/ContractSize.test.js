const { expect } = require("chai");
const { artifacts } = require("hardhat");

/**
 * The local test network allows oversized contracts (only for the DexFeeVaultV2Mock test mock), so the
 * contracts that are deployed for real are held to the EIP-170 limit here.
 */
describe("Deployable size (EIP-170)", function () {
  const LIMIT = 24_576;
  for (const name of ["DexFeeVaultUpgradeable", "AggregatorEntrypoint"]) {
    it(`${name} fits in ${LIMIT} bytes`, async function () {
      const { deployedBytecode } = await artifacts.readArtifact(name);
      const size = (deployedBytecode.length - 2) / 2;
      expect(size).to.be.at.most(LIMIT);
    });
  }
});
