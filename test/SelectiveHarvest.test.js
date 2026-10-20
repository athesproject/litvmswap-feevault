const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * harvest() loops every registered source — 444 pairs and 471 pools on LitVM —
 * and costs ~31M gas per cycle even when almost none of them hold fees. The
 * selective path lets the keeper collect only what actually has something,
 * which it can determine with free off-chain reads.
 */
describe("Selective harvesting (v2.7)", function () {
  let vault, tokenA, tokenB, owner, partner, core, treasury, stranger;

  beforeEach(async function () {
    [owner, partner, core, treasury, stranger] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("A", "A");
    tokenB = await MockERC20.deploy("B", "B");

    const ids = ["PARTNERS", "CORE", "TREASURY"].map(n => ethers.keccak256(ethers.toUtf8Bytes(n)));
    const Vault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
    vault = await upgrades.deployProxy(Vault, [owner.address, [
      { id: ids[0], wallet: partner.address, bps: 4000, name: "Partners" },
      { id: ids[1], wallet: core.address, bps: 3500, name: "Core" },
      { id: ids[2], wallet: treasury.address, bps: 2500, name: "Treasury" },
    ], true], { kind: "uups", initializer: "initialize" });
    await vault.setWrappedNativeToken(await tokenA.getAddress());
  });

  async function makePool(fees0, fees1) {
    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const p = await Pool.deploy(await tokenA.getAddress(), await tokenB.getAddress(), 3000);
    await tokenA.mint(await p.getAddress(), ethers.parseEther("1000"));
    await tokenB.mint(await p.getAddress(), ethers.parseEther("1000"));
    await p.setProtocolFees(fees0, fees1);
    return p;
  }

  it("reports at least 2.7.0 — the selective surface", async function () {
    // A floor, not an exact match: a patch bump should not fail this suite.
    const [maj, min] = (await vault.version()).split(".").map(Number);
    expect(maj > 2 || (maj === 2 && min >= 7), "version must be >= 2.7.0").to.be.true;
  });

  it("collects protocol fees only from the pools it is given", async function () {
    const withFees = await makePool(ethers.parseEther("5"), ethers.parseEther("3"));
    const empty = await makePool(0n, 0n);

    const before = await tokenA.balanceOf(await vault.getAddress());
    const n = await vault.collectV3ProtocolFees.staticCall([
      await withFees.getAddress(), await empty.getAddress(),
    ]);
    await vault.collectV3ProtocolFees([await withFees.getAddress(), await empty.getAddress()]);

    expect(n).to.equal(1n, "only the funded pool counts as collected");
    expect(await tokenA.balanceOf(await vault.getAddress()) - before).to.equal(ethers.parseEther("5"));
    expect(await tokenB.balanceOf(await vault.getAddress())).to.equal(ethers.parseEther("3"));
  });

  it("credits the V3 revenue stream, not the aggregator stream", async function () {
    const p = await makePool(ethers.parseEther("5"), 0n); // tokenA is wrapped-native here
    const v3Before = await vault.cumulativeV3FeesETH();
    const aggBefore = await vault.cumulativeAggregatorFeesETH();
    await vault.collectV3ProtocolFees([await p.getAddress()]);
    expect(await vault.cumulativeV3FeesETH()).to.be.gt(v3Before);
    expect(await vault.cumulativeAggregatorFeesETH()).to.equal(aggBefore);
  });

  it("survives one reverting pool in the batch", async function () {
    const good = await makePool(ethers.parseEther("5"), ethers.parseEther("1"));
    const bad = await makePool(ethers.parseEther("9"), ethers.parseEther("9"));
    await bad.setCollectShouldRevert(true);

    const n = await vault.collectV3ProtocolFees.staticCall([
      await bad.getAddress(), await good.getAddress(),
    ]);
    expect(n).to.equal(1n, "the good pool is still collected");
    await expect(vault.collectV3ProtocolFees([await bad.getAddress(), await good.getAddress()]))
      .to.emit(vault, "V3ProtocolCollectFailed");
  });

  it("is permissionless — anyone may push value into the vault", async function () {
    const p = await makePool(ethers.parseEther("2"), ethers.parseEther("2"));
    await expect(vault.connect(stranger).collectV3ProtocolFees([await p.getAddress()]))
      .to.not.be.reverted;
  });

  it("is a no-op on an empty list", async function () {
    expect(await vault.collectV3ProtocolFees.staticCall([])).to.equal(0n);
    await expect(vault.collectV3ProtocolFees([])).to.not.be.reverted;
  });

  it("costs far less than collecting from every registered pool", async function () {
    // 12 pools registered, only 1 holding fees.
    const funded = await makePool(ethers.parseEther("5"), ethers.parseEther("5"));
    const pools = [await funded.getAddress()];
    for (let i = 0; i < 11; i++) pools.push(await (await makePool(0n, 0n)).getAddress());
    await vault.addV3PoolsBatch(pools);

    const selective = await vault.collectV3ProtocolFees.estimateGas([pools[0]]);
    const sweep = await vault.collectV3ProtocolFees.estimateGas([...(await vault.getRegisteredV3Pools())]);
    expect(selective).to.be.lt(sweep);
    console.log(`        selective: ${selective} gas vs every registered pool: ${sweep} gas`);
  });

  it("respects pause", async function () {
    const p = await makePool(ethers.parseEther("1"), ethers.parseEther("1"));
    await vault.pause();
    await expect(vault.collectV3ProtocolFees([await p.getAddress()])).to.be.reverted;
  });

  it("collectV3Positions harvests owned NFTs without sweeping pools or pairs", async function () {
    await expect(vault.collectV3Positions()).to.not.be.reverted;
    expect(await vault.collectV3Positions.staticCall()).to.equal(0n);
  });
});
