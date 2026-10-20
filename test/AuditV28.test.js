const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * One test per audit finding fixed in v2.8 (s2/plan/fee-vault-audit-and-redesign.md, section 2),
 * plus the upgrade from the deployed v2.7.1 code with storage and balances checked.
 */
describe("Audit fixes (v2.8)", function () {
  let vault, tokenA, owner, partner, core, treasury, stranger;
  let ids;
  const E = (n) => ethers.parseEther(String(n));

  async function deployVault(name = "DexFeeVaultUpgradeable") {
    const Vault = await ethers.getContractFactory(name);
    return upgrades.deployProxy(Vault, [owner.address, [
      { id: ids[0], wallet: partner.address, bps: 4000, name: "Partners" },
      { id: ids[1], wallet: core.address, bps: 3500, name: "Core Team" },
      { id: ids[2], wallet: treasury.address, bps: 2500, name: "Treasury" },
    ], true], { kind: "uups", initializer: "initialize" });
  }

  beforeEach(async function () {
    [owner, partner, core, treasury, stranger] = await ethers.getSigners();
    ids = ["PARTNERS", "CORE", "TREASURY"].map((n) => ethers.keccak256(ethers.toUtf8Bytes(n)));
    tokenA = await (await ethers.getContractFactory("MockERC20")).deploy("A", "A");
    vault = await deployVault();
  });

  it("reports 2.8.0", async function () {
    expect(await vault.version()).to.equal("2.8.0");
  });

  it("V1: a beneficiary cannot re-enter distribution while it is being paid", async function () {
    const evil = await (await ethers.getContractFactory("ReentrantBeneficiary")).deploy(await vault.getAddress());
    await vault.setBeneficiary(ids[0], await evil.getAddress(), 4000, "Partners");
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(10) });

    await expect(vault.distributeRegistered(true)).to.changeEtherBalances(
      [evil, core, treasury], [E(4), E(3.5), E(2.5)],
    );
    expect(await evil.attempts()).to.be.gt(0n);
    expect(await evil.reentered()).to.equal(0n, "the nested distribution was refused");
    expect(await ethers.provider.getBalance(await vault.getAddress())).to.be.gte(await vault.totalReservedETHFees());
  });

  it("V2: one broken registered token does not stop the others", async function () {
    const broken = await (await ethers.getContractFactory("BrokenToken")).deploy();
    await vault.addDistributionToken(await broken.getAddress());
    await vault.addDistributionToken(await tokenA.getAddress());
    await tokenA.mint(await vault.getAddress(), E(100));
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(1) });

    await expect(vault.distributeRegistered(false))
      .to.emit(vault, "DistributionSkipped").withArgs(await broken.getAddress());
    expect(await vault.pendingTokens(await tokenA.getAddress(), partner.address)).to.equal(E(40));
    expect(await vault.pendingETH(partner.address)).to.equal(E(0.4));
  });

  it("V2: a token push that fails stays owed instead of reverting the run", async function () {
    const blk = await (await ethers.getContractFactory("BlockingToken")).deploy();
    await vault.addDistributionToken(await blk.getAddress());
    await blk.mint(await vault.getAddress(), E(100));
    await blk.setBlocked(core.address, true);

    await vault.distributeRegistered(true);
    expect(await blk.balanceOf(partner.address)).to.equal(E(40));
    expect(await blk.balanceOf(treasury.address)).to.equal(E(25));
    expect(await vault.pendingTokens(await blk.getAddress(), core.address)).to.equal(E(35));
    expect(await vault.totalReservedTokenFees(await blk.getAddress())).to.equal(E(35));
  });

  it("V3: emergencyWithdraw cannot take what beneficiaries are owed", async function () {
    const t = await tokenA.getAddress();
    await tokenA.mint(await vault.getAddress(), E(100));
    await vault.distributeToken(t, false); // all 100 now owed
    await tokenA.mint(await vault.getAddress(), E(10)); // 10 not owed
    await expect(vault.emergencyWithdraw(t, stranger.address, E(11))).to.be.revertedWithCustomError(vault, "AmountReserved");
    await vault.emergencyWithdraw(t, stranger.address, E(10));
    expect(await tokenA.balanceOf(stranger.address)).to.equal(E(10));

    await owner.sendTransaction({ to: await vault.getAddress(), value: E(1) });
    await vault.distributeETH(false); // 1 owed
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(0.5) });
    await expect(vault.emergencyWithdraw(ethers.ZeroAddress, stranger.address, E(0.6))).to.be.revertedWithCustomError(vault, "AmountReserved");
    await expect(vault.emergencyWithdraw(ethers.ZeroAddress, stranger.address, E(0.5))).to.changeEtherBalance(stranger, E(0.5));
  });

  it("V4: every distribution path follows the same rule", async function () {
    await vault.setPublicDistributionAllowed(false);
    await expect(vault.connect(stranger).distributeRegistered(false)).to.be.revertedWithCustomError(vault, "DistributionNotAllowed");
    expect(vault.interface.getFunction("harvestAndDistribute")).to.equal(null);
  });

  it("V5: factoryCall only reaches the V3 factory", async function () {
    const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    await vault.setFactories(ethers.ZeroAddress, await factory.getAddress());
    const transfer = tokenA.interface.encodeFunctionData("transfer", [stranger.address, 1n]);
    await expect(vault.factoryCall(await tokenA.getAddress(), transfer)).to.be.revertedWithCustomError(vault, "NotV3Factory");
    await vault.factoryCall(await factory.getAddress(), factory.interface.encodeFunctionData("setOwner", [stranger.address]));
    expect(await factory.owner()).to.equal(stranger.address);
    await expect(vault.connect(stranger).factoryCall(await factory.getAddress(), "0x")).to.be.reverted;
  });

  it("V6: anyone can pay a beneficiary what it is owed, and only to that beneficiary", async function () {
    const t = await tokenA.getAddress();
    await tokenA.mint(await vault.getAddress(), E(100));
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(2) });
    await vault.distributeETH(false);
    await vault.distributeToken(t, false);

    await expect(vault.connect(stranger).claimFor(partner.address, [t], true)).to.changeEtherBalances([partner, stranger], [E(0.8), 0n]);
    expect(await tokenA.balanceOf(partner.address)).to.equal(E(40));
    expect(await tokenA.balanceOf(stranger.address)).to.equal(0n);
    expect(await vault.pendingETH(partner.address)).to.equal(0n);
    expect(await vault.pendingTokens(t, partner.address)).to.equal(0n);
  });

  it("V6: a payout claimFor cannot make stays owed", async function () {
    const blk = await (await ethers.getContractFactory("BlockingToken")).deploy();
    const b = await blk.getAddress();
    await blk.mint(await vault.getAddress(), E(100));
    await vault.distributeToken(b, false);
    await blk.setBlocked(partner.address, true);

    await expect(vault.connect(stranger).claimFor(partner.address, [b], false))
      .to.emit(vault, "ClaimSkipped").withArgs(partner.address, b, E(40));
    expect(await vault.pendingTokens(b, partner.address)).to.equal(E(40));
    expect(await vault.totalReservedTokenFees(b)).to.equal(E(100));
  });

  it("V6: the admin can move owed balances off a compromised wallet; the books stay exact", async function () {
    const t = await tokenA.getAddress();
    const fresh = ethers.Wallet.createRandom().address;
    await tokenA.mint(await vault.getAddress(), E(100));
    await owner.sendTransaction({ to: await vault.getAddress(), value: E(1) });
    await vault.distributeETH(false);
    await vault.distributeToken(t, false);
    const reserved = await vault.totalReservedTokenFees(t);

    await expect(vault.connect(stranger).movePending(treasury.address, fresh, [t], true)).to.be.reverted;
    await expect(vault.movePending(treasury.address, fresh, [t], true))
      .to.emit(vault, "PendingMoved").withArgs(treasury.address, fresh, t, E(25));
    expect(await vault.pendingTokens(t, treasury.address)).to.equal(0n);
    expect(await vault.pendingTokens(t, fresh)).to.equal(E(25));
    expect(await vault.pendingETH(fresh)).to.equal(E(0.25));
    expect(await vault.totalReservedTokenFees(t)).to.equal(reserved);
    await vault.connect(stranger).claimFor(fresh, [t], true);
    expect(await tokenA.balanceOf(fresh)).to.equal(E(25));
  });

  it("V7: a call to a function the vault does not have reverts unless it carries value", async function () {
    const to = await vault.getAddress();
    await expect(owner.sendTransaction({ to, data: "0x12345678" })).to.be.revertedWithCustomError(vault, "UnknownFunction");
    await expect(owner.sendTransaction({ to, data: "0x12345678", value: 1n })).to.emit(vault, "FeeReceived");
  });

  it("V9: anyone can switch on the protocol fee, only for real pools still at zero, at the admin's default", async function () {
    const Pool = await ethers.getContractFactory("MockUniswapV3Pool");
    const tokenB = await (await ethers.getContractFactory("MockERC20")).deploy("B", "B");
    const [a, b] = [await tokenA.getAddress(), await tokenB.getAddress()];
    const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    await vault.setFactories(ethers.ZeroAddress, await factory.getAddress());
    const real = await Pool.deploy(a, b, 3000);
    const fake = await Pool.deploy(a, b, 500); // not created by the factory
    const exempt = await Pool.deploy(a, b, 10000);
    const already = await Pool.deploy(a, b, 100);
    for (const [p, fee] of [[real, 3000], [exempt, 10000], [already, 100]]) await factory.register(await p.getAddress(), a, b, fee);
    await already.setFeeProtocol(6, 6);
    const list = [real, fake, exempt, already].map((p) => p.target).concat([stranger.address]);

    await expect(vault.enableProtocolFee(list)).to.be.revertedWithCustomError(vault, "ProtocolFeeDefaultUnset");
    await expect(vault.setDefaultFeeProtocol(3, 4)).to.be.revertedWithCustomError(vault, "InvalidFeeProtocol");
    await expect(vault.connect(stranger).setDefaultFeeProtocol(4, 4)).to.be.reverted;
    await vault.setDefaultFeeProtocol(4, 4);
    await vault.setProtocolFeeExempt(await exempt.getAddress(), true);

    expect(await vault.connect(stranger).enableProtocolFee.staticCall(list)).to.equal(1n);
    await expect(vault.connect(stranger).enableProtocolFee(list)).to.emit(vault, "V3FeeProtocolSet").withArgs(await real.getAddress(), 4, 4);
    const fp = async (p) => (await p.slot0())[5];
    expect(await fp(real)).to.equal(4n + (4n << 4n));
    expect(await fp(fake)).to.equal(0n);
    expect(await fp(exempt)).to.equal(0n);
    expect(await fp(already)).to.equal(6n + (6n << 4n));

    await vault.pause();
    await expect(vault.enableProtocolFee(list)).to.be.reverted;
  });

  it("V10: a beneficiary wallet cannot be the vault itself", async function () {
    await expect(vault.setBeneficiary(ids[0], await vault.getAddress(), 4000, "Partners")).to.be.revertedWithCustomError(vault, "InvalidAddress");
  });

  describe("the same scenarios on the deployed v2.7.1 (evidence for the findings)", function () {
    let old;
    beforeEach(async function () { old = await deployVault("DexFeeVaultUpgradeableV271"); });

    it("V1: a re-entering beneficiary takes more than its share and leaves the vault owing more than it holds", async function () {
      const evil = await (await ethers.getContractFactory("ReentrantBeneficiary")).deploy(await old.getAddress());
      await old.setBeneficiary(ids[0], await evil.getAddress(), 4000, "Partners");
      await owner.sendTransaction({ to: await old.getAddress(), value: E(10) });
      await old.distributeRegistered(true);
      expect(await evil.reentered()).to.be.gt(0n);
      expect(await ethers.provider.getBalance(await evil.getAddress())).to.be.gt(E(4));
      expect(await old.totalReservedETHFees()).to.be.gt(await ethers.provider.getBalance(await old.getAddress()));
    });

    it("V2: one broken registered token stops distribution of everything", async function () {
      const broken = await (await ethers.getContractFactory("BrokenToken")).deploy();
      await old.addDistributionToken(await broken.getAddress());
      await owner.sendTransaction({ to: await old.getAddress(), value: E(1) });
      await expect(old.distributeRegistered(false)).to.be.reverted;
    });

    it("V3: emergencyWithdraw takes funds beneficiaries are owed, and their claims then fail", async function () {
      await owner.sendTransaction({ to: await old.getAddress(), value: E(1) });
      await old.distributeETH(false);
      await old.emergencyWithdraw(ethers.ZeroAddress, stranger.address, E(1));
      await expect(old.connect(partner).claimETH()).to.be.reverted;
    });
  });

  it("upgrades from the deployed v2.7.1 code with storage and every balance intact", async function () {
    const old = await deployVault("DexFeeVaultUpgradeableV271");
    const t = await tokenA.getAddress();
    await old.setWrappedNativeToken(t);
    await old.addDistributionToken(t);
    await tokenA.mint(await old.getAddress(), E(100));
    await owner.sendTransaction({ to: await old.getAddress(), value: E(3) });
    await old.distributeRegistered(false);
    await tokenA.mint(await old.getAddress(), E(7)); // waiting to be split
    const factory = await (await ethers.getContractFactory("MockUniswapV3Factory")).deploy();
    await old.setFactories(ethers.ZeroAddress, await factory.getAddress());

    const snap = async (v) => ({
      totalBps: await v.totalBps(),
      ids: [...(await v.getAllBeneficiaryIds())],
      partner: (await v.getBeneficiary(ids[0])).wallet,
      pendingETH: await v.pendingETH(treasury.address),
      pendingA: await v.pendingTokens(t, core.address),
      reservedETH: await v.totalReservedETHFees(),
      reservedA: await v.totalReservedTokenFees(t),
      tokens: [...(await v.getRegisteredDistributionTokens())],
      wn: await v.wrappedNativeToken(),
      v3: await v.v3Factory(),
      dist: await v.cumulativeDistributedETH(),
      pub: await v.publicDistributionAllowed(),
    });
    const before = await snap(old);
    expect(await old.version()).to.equal("2.7.1");

    // The plugin refuses the upgrade if the storage layout is incompatible.
    const upgraded = await upgrades.upgradeProxy(await old.getAddress(), await ethers.getContractFactory("DexFeeVaultUpgradeable"), { kind: "uups" });
    expect(await upgraded.version()).to.equal("2.8.0");
    expect(await snap(upgraded)).to.deep.equal(before);
    expect(await upgraded.defaultFeeProtocol0()).to.equal(0n);

    await expect(upgraded.connect(stranger).claimFor(core.address, [t], true)).to.changeEtherBalance(core, E(1.05));
    expect(await tokenA.balanceOf(core.address)).to.equal(E(35));
    await upgraded.distributeRegistered(false); // the 7 waiting
    expect(await upgraded.pendingTokens(t, partner.address)).to.equal(E(40) + E(2.8));
  });
});
