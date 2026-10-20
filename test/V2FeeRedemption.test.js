const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * Regression suite for the v2.6 fix.
 *
 * Uniswap V2 protocol fees are paid as *LP tokens* minted to factory.feeTo, not
 * as underlying tokens. The pre-v2.6 vault only called skim(), which returns
 * nothing on a synced pair, so every bit of V2 revenue accumulated as LP the
 * vault could never convert. These tests pin the redemption path.
 */
describe("V2 protocol-fee redemption (v2.6)", function () {
  let vault, tokenA, tokenB, pair, factory;
  let owner, partner, core, treasury;

  beforeEach(async function () {
    [owner, partner, core, treasury] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("Token A", "TKNA");
    tokenB = await MockERC20.deploy("Token B", "TKNB");

    const MockV2 = await ethers.getContractFactory("MockUniswapV2Pair");
    pair = await MockV2.deploy(await tokenA.getAddress(), await tokenB.getAddress());

    const MockFactory = await ethers.getContractFactory("MockUniswapV2Factory");
    factory = await MockFactory.deploy();

    // Pair holds real reserves.
    await tokenA.mint(await pair.getAddress(), ethers.parseEther("1000"));
    await tokenB.mint(await pair.getAddress(), ethers.parseEther("4000"));

    const ids = ["PARTNERS", "CORE", "TREASURY"].map(n => ethers.keccak256(ethers.toUtf8Bytes(n)));
    const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
    vault = await upgrades.deployProxy(DexFeeVault, [owner.address, [
      { id: ids[0], wallet: partner.address, bps: 4000, name: "Partners" },
      { id: ids[1], wallet: core.address, bps: 3500, name: "Core" },
      { id: ids[2], wallet: treasury.address, bps: 2500, name: "Treasury" },
    ], true], { kind: "uups", initializer: "initialize" });

    // Point wrapped-native at a real contract so harvest attribution has something
    // to measure; on LitVM this is wzkLTC.
    await vault.setWrappedNativeToken(await tokenA.getAddress());
  });

  /** Simulate factory.feeTo minting protocol-fee LP to the vault. */
  async function accrueProtocolFeeLp(lpToVault, lpToOthers) {
    await pair.mintTo(owner.address, ethers.parseEther(String(lpToOthers)));
    await pair.mintTo(await vault.getAddress(), ethers.parseEther(String(lpToVault)));
  }

  it("redeems fee LP into both underlying tokens", async function () {
    await accrueProtocolFeeLp(100, 900); // vault holds 10% of supply

    const vaultAddr = await vault.getAddress();
    expect(await pair.balanceOf(vaultAddr)).to.equal(ethers.parseEther("100"));
    expect(await tokenA.balanceOf(vaultAddr)).to.equal(0n);

    await vault.redeemV2LpTokens([await pair.getAddress()]);

    // 10% of each reserve should now sit in the vault, and the LP is gone.
    expect(await pair.balanceOf(vaultAddr)).to.equal(0n);
    expect(await tokenA.balanceOf(vaultAddr)).to.equal(ethers.parseEther("100"));
    expect(await tokenB.balanceOf(vaultAddr)).to.equal(ethers.parseEther("400"));
  });

  it("emits V2LpRedeemed with the burned amount", async function () {
    await accrueProtocolFeeLp(100, 900);
    await expect(vault.redeemV2LpTokens([await pair.getAddress()]))
      .to.emit(vault, "V2LpRedeemed");
  });

  it("credits the V2 revenue stream instead of the aggregator stream", async function () {
    await accrueProtocolFeeLp(100, 900);
    const v2Before = await vault.cumulativeV2FeesETH();
    const aggBefore = await vault.cumulativeAggregatorFeesETH();
    await vault.redeemV2LpTokens([await pair.getAddress()]);

    // tokenA is the configured wrapped-native, so the gain lands on the V2 stream.
    expect(await vault.cumulativeV2FeesETH()).to.be.gt(v2Before);
    expect(await vault.cumulativeAggregatorFeesETH()).to.equal(aggBefore);
  });

  it("redeems every registered pair when given the registry", async function () {
    await vault.addV2Pair(await pair.getAddress());
    await accrueProtocolFeeLp(100, 900);

    await vault.redeemV2LpTokens([...(await vault.getRegisteredV2Pairs())]);

    expect(await pair.balanceOf(await vault.getAddress())).to.equal(0n);
    expect(await tokenB.balanceOf(await vault.getAddress())).to.be.gt(0n);
  });

  it("is a no-op when the vault holds no LP", async function () {
    await expect(vault.redeemV2LpTokens([await pair.getAddress()])).to.not.be.reverted;
    expect(await vault.redeemV2LpTokens.staticCall([await pair.getAddress()])).to.equal(0n);
  });

  it("does not strand LP inside the pair when burn reverts", async function () {
    await accrueProtocolFeeLp(100, 900);
    await pair.setBurnShouldRevert(true);

    const vaultAddr = await vault.getAddress();
    await expect(vault.redeemV2LpTokens([await pair.getAddress()])).to.not.be.reverted;

    // The external self-call rolls the LP transfer back atomically — the LP must
    // still be in the vault, never left sitting in the pair for anyone to claim.
    expect(await pair.balanceOf(vaultAddr)).to.equal(ethers.parseEther("100"));
    expect(await pair.balanceOf(await pair.getAddress())).to.equal(0n);
  });

  it("skips dust rather than reverting the whole harvest", async function () {
    await pair.mintTo(owner.address, ethers.parseEther("1000000000"));
    await pair.mintTo(await vault.getAddress(), 1n); // 1 wei of LP -> rounds to zero
    await expect(vault.redeemV2LpTokens([await pair.getAddress()]))
      .to.emit(vault, "V2LpRedeemSkipped");
  });

  it("survives one bad pair in a batch", async function () {
    const MockV2 = await ethers.getContractFactory("MockUniswapV2Pair");
    const bad = await MockV2.deploy(await tokenA.getAddress(), await tokenB.getAddress());
    await bad.mintTo(await vault.getAddress(), ethers.parseEther("50"));
    await bad.setBurnShouldRevert(true);

    await accrueProtocolFeeLp(100, 900);

    const redeemed = await vault.redeemV2LpTokens.staticCall([
      await bad.getAddress(),
      await pair.getAddress(),
    ]);
    expect(redeemed).to.equal(1n); // good pair still redeemed
  });

  it("works on pairs that were never registered", async function () {
    await accrueProtocolFeeLp(100, 900);
    expect(await vault.isRegisteredV2Pair(await pair.getAddress())).to.equal(false);
    await vault.redeemV2LpTokens([await pair.getAddress()]);
    expect(await tokenB.balanceOf(await vault.getAddress())).to.be.gt(0n);
  });
});

describe("Registry self-sync (v2.6)", function () {
  let vault, factory, owner, partner, core, treasury;

  beforeEach(async function () {
    [owner, partner, core, treasury] = await ethers.getSigners();
    const MockFactory = await ethers.getContractFactory("MockUniswapV2Factory");
    factory = await MockFactory.deploy();

    const ids = ["PARTNERS", "CORE", "TREASURY"].map(n => ethers.keccak256(ethers.toUtf8Bytes(n)));
    const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
    vault = await upgrades.deployProxy(DexFeeVault, [owner.address, [
      { id: ids[0], wallet: partner.address, bps: 4000, name: "Partners" },
      { id: ids[1], wallet: core.address, bps: 3500, name: "Core" },
      { id: ids[2], wallet: treasury.address, bps: 2500, name: "Treasury" },
    ], true], { kind: "uups", initializer: "initialize" });

    await vault.setFactories(await factory.getAddress(), ethers.ZeroAddress);
  });

  async function seedPairs(n) {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const MockV2 = await ethers.getContractFactory("MockUniswapV2Pair");
    const a = await MockERC20.deploy("A", "A");
    const b = await MockERC20.deploy("B", "B");
    for (let i = 0; i < n; i++) {
      const p = await MockV2.deploy(await a.getAddress(), await b.getAddress());
      await factory.addPair(await p.getAddress());
    }
  }

  it("pulls every factory pair into the registry", async function () {
    await seedPairs(5);
    await vault.syncV2Pairs(100);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(5);
  });

  it("pages with a cursor so it cannot run out of gas", async function () {
    await seedPairs(5);
    await vault.syncV2Pairs(2);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(2);
    expect(await vault.v2SyncCursor()).to.equal(2n);

    await vault.syncV2Pairs(2);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(4);

    await vault.syncV2Pairs(10); // clamps to the end
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(5);
    expect(await vault.v2SyncCursor()).to.equal(5n);
  });

  it("picks up pairs created after the last sync", async function () {
    await seedPairs(3);
    await vault.syncV2Pairs(100);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(3);

    await seedPairs(2); // two new pools launch
    await vault.syncV2Pairs(100);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(5);
  });

  it("never double-registers", async function () {
    await seedPairs(3);
    await vault.syncV2Pairs(100);
    await vault.resetV2SyncCursor();
    await vault.syncV2Pairs(100);
    expect((await vault.getRegisteredV2Pairs()).length).to.equal(3);
  });

  it("reverts when no factory is configured", async function () {
    await vault.setFactories(ethers.ZeroAddress, ethers.ZeroAddress);
    await expect(vault.syncV2Pairs(10)).to.be.reverted;
  });
});
