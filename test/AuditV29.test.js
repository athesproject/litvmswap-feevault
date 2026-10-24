const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * Vault 2.9.0 (plan/litvm-team-audit-triage.md, W3): ATH-08 deposits at the received amount, ATH-14 no
 * wrapped-native fallback and exact distribution counters, ATH-18 a split that is always complete.
 */
describe("Audit fixes (v2.9)", function () {
  let owner, partner, core, treasury, stranger, wrapped, ids;
  const E = (n) => ethers.parseEther(String(n));
  const split = () => [
    { id: ids[0], wallet: partner.address, bps: 4000, name: "Partners" },
    { id: ids[1], wallet: core.address, bps: 3500, name: "Core Team" },
    { id: ids[2], wallet: treasury.address, bps: 2500, name: "Treasury" },
  ];

  async function deploy(beneficiaries = split(), wrappedNative) {
    const Vault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
    return upgrades.deployProxy(Vault, [owner.address, beneficiaries, true, wrappedNative ?? await wrapped.getAddress()],
      { kind: "uups", initializer: "initialize" });
  }

  beforeEach(async function () {
    [owner, partner, core, treasury, stranger] = await ethers.getSigners();
    ids = ["PARTNERS", "CORE", "TREASURY"].map((n) => ethers.keccak256(ethers.toUtf8Bytes(n)));
    wrapped = await (await ethers.getContractFactory("MockERC20")).deploy("Wrapped Native", "WNATIVE");
  });

  it("is version 2.9.0 without the removed entry points", async function () {
    const vault = await deploy();
    expect(await vault.version()).to.equal("2.9.0");
    expect(vault.depositFee).to.equal(undefined);
    expect(vault.removeBeneficiary).to.equal(undefined);
  });

  describe("ATH-14: wrapped native token", function () {
    it("must be a contract at initialization and when changed", async function () {
      const Vault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
      await expect(upgrades.deployProxy(Vault, [owner.address, split(), true, stranger.address], { kind: "uups" }))
        .to.be.revertedWithCustomError(Vault, "InvalidAddress");
      const vault = await deploy();
      expect(await vault.wrappedNativeToken()).to.equal(await wrapped.getAddress());
      await expect(vault.setWrappedNativeToken(stranger.address)).to.be.revertedWithCustomError(vault, "InvalidAddress");
      await expect(vault.setWrappedNativeToken(ethers.ZeroAddress)).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });

  describe("ATH-14: distribution counts what was credited", function () {
    it("native: the counter equals the shares, the remainder stays for the next run", async function () {
      const vault = await deploy();
      const addr = await vault.getAddress();
      await owner.sendTransaction({ to: addr, value: 10001n });
      // 4000/3500/2500 bps of 10001 wei = 4000 + 3500 + 2500, 1 wei left over.
      await expect(vault.distributeETH(false))
        .to.emit(vault, "DistributionRemainder").withArgs(ethers.ZeroAddress, 1n)
        .and.to.emit(vault, "FeesDistributed").withArgs(ethers.ZeroAddress, 10000n, false);
      expect(await vault.cumulativeDistributedETH()).to.equal(10000n);
      expect(await vault.totalReservedETHFees()).to.equal(10000n);
      expect(await ethers.provider.getBalance(addr) - await vault.totalReservedETHFees()).to.equal(1n);

      // The leftover wei joins the next distribution instead of being counted twice.
      await owner.sendTransaction({ to: addr, value: 9999n });
      await vault.distributeETH(false);
      expect(await vault.cumulativeDistributedETH()).to.equal(20000n);
      expect(await ethers.provider.getBalance(addr) - await vault.totalReservedETHFees()).to.equal(0n);
    });

    it("tokens: event amounts are what was credited", async function () {
      const vault = await deploy();
      const token = await (await ethers.getContractFactory("MockERC20")).deploy("T", "T");
      await vault.addDistributionToken(await token.getAddress());
      await token.mint(await vault.getAddress(), 10001n);
      await expect(vault.distributeRegistered(false))
        .to.emit(vault, "DistributionRemainder").withArgs(await token.getAddress(), 1n)
        .and.to.emit(vault, "FeesDistributed").withArgs(await token.getAddress(), 10000n, false);
      expect(await vault.totalReservedTokenFees(await token.getAddress())).to.equal(10000n);
    });

    it("reconciles: received = claimed + owed + unallocated", async function () {
      const vault = await deploy();
      const addr = await vault.getAddress();
      for (const v of [12345n, 678n, E("0.3")]) {
        await owner.sendTransaction({ to: addr, value: v });
        await vault.distributeETH(false);
      }
      await vault.connect(partner).claimETH();
      const received = 12345n + 678n + E("0.3");
      const claimed = await vault.cumulativeClaimedETH();
      const owed = await vault.totalReservedETHFees();
      const unallocated = await ethers.provider.getBalance(addr) - owed;
      expect(claimed + owed + unallocated).to.equal(received);
      expect(await vault.cumulativeDistributedETH()).to.equal(claimed + owed);
    });
  });

  describe("ATH-08: deposits record what arrived", function () {
    it("a fee-on-transfer token is recorded at the received amount", async function () {
      const vault = await deploy();
      const fot = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy();
      await fot.mint(owner.address, E(100));
      await fot.approve(await vault.getAddress(), E(100));
      await expect(vault.depositAggregatorFee(await fot.getAddress(), E(100), "0x"))
        .to.emit(vault, "FeeDeposited").withArgs(await fot.getAddress(), owner.address, E(99));
      expect(await fot.balanceOf(await vault.getAddress())).to.equal(E(99));
    });

    it("refuses native sent with a token deposit", async function () {
      const vault = await deploy();
      const token = await (await ethers.getContractFactory("MockERC20")).deploy("T", "T");
      await token.approve(await vault.getAddress(), E(1));
      await expect(vault.depositAggregatorFee(await token.getAddress(), E(1), "0x", { value: 1 }))
        .to.be.revertedWithCustomError(vault, "UnexpectedNativeValue");
    });
  });

  describe("ATH-18: the split is always complete", function () {
    it("initialization takes a complete split or none", async function () {
      const Vault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
      const partial = [{ id: ids[0], wallet: partner.address, bps: 7000, name: "Partners" }];
      await expect(upgrades.deployProxy(Vault, [owner.address, partial, true, await wrapped.getAddress()], { kind: "uups" }))
        .to.be.revertedWithCustomError(Vault, "InvalidBpsTotal");

      const empty = await deploy([]);
      await owner.sendTransaction({ to: await empty.getAddress(), value: 100n });
      await expect(empty.distributeRegistered(false)).to.be.revertedWithCustomError(empty, "InvalidBpsTotal");
      await empty.replaceBeneficiaries(split());
      await empty.distributeRegistered(false);
      expect(await empty.pendingETH(partner.address)).to.equal(40n);
    });

    it("replaceBeneficiaries keeps what removed wallets are owed", async function () {
      const vault = await deploy();
      await owner.sendTransaction({ to: await vault.getAddress(), value: 10000n });
      await vault.distributeETH(false);
      await vault.replaceBeneficiaries([
        { id: ids[0], wallet: partner.address, bps: 6000, name: "Partners" },
        { id: ids[1], wallet: core.address, bps: 4000, name: "Core Team" },
      ]);
      expect(await vault.pendingETH(treasury.address)).to.equal(2500n);
      const before = await ethers.provider.getBalance(treasury.address);
      const tx = await vault.connect(treasury).claimETH();
      const r = await tx.wait();
      expect(await ethers.provider.getBalance(treasury.address) - before + r.gasUsed * r.gasPrice).to.equal(2500n);
    });
  });

  describe("upgrade from 2.8.0", function () {
    it("keeps every value the live vault holds", async function () {
      const Old = await ethers.getContractFactory("DexFeeVaultUpgradeableV28");
      const old = await upgrades.deployProxy(Old, [owner.address, split(), true], { kind: "uups", initializer: "initialize" });
      await old.setWrappedNativeToken(await wrapped.getAddress());
      const token = await (await ethers.getContractFactory("MockERC20")).deploy("T", "T");
      await old.addDistributionToken(await token.getAddress());
      await token.mint(await old.getAddress(), E(5));
      await owner.sendTransaction({ to: await old.getAddress(), value: E(1) });
      await old.distributeRegistered(false);
      await old.setDefaultFeeProtocol(4, 4);

      const snap = async (v) => ({
        ids: [...(await v.getAllBeneficiaryIds())],
        totalBps: await v.totalBps(),
        partner: (await v.getBeneficiary(ids[0])).wallet,
        pendingETH: await v.pendingETH(treasury.address),
        pendingT: await v.pendingTokens(await token.getAddress(), core.address),
        reservedETH: await v.totalReservedETHFees(),
        reservedT: await v.totalReservedTokenFees(await token.getAddress()),
        tokens: [...(await v.getRegisteredDistributionTokens())],
        wn: await v.wrappedNativeToken(),
        dist: await v.cumulativeDistributedETH(),
        pub: await v.publicDistributionAllowed(),
        fee0: await v.defaultFeeProtocol0(),
        admin: await v.hasRole(ethers.ZeroHash, owner.address),
      });
      const before = await snap(old);
      expect(await old.version()).to.equal("2.8.0");
      const upgraded = await upgrades.upgradeProxy(await old.getAddress(), await ethers.getContractFactory("DexFeeVaultUpgradeable"), { kind: "uups" });
      expect(await upgraded.version()).to.equal("2.9.0");
      expect(await snap(upgraded)).to.deep.equal(before);
    });

    it("storage layout is compatible (OpenZeppelin check)", async function () {
      await upgrades.validateUpgrade(
        await ethers.getContractFactory("DexFeeVaultUpgradeableV28"),
        await ethers.getContractFactory("DexFeeVaultUpgradeable"),
        { kind: "uups" },
      );
    });
  });
});
