const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * The protocol fee used to be advisory: feeCollectorAddress and feeBps come from
 * calldata, so any caller could route the fee to themselves or zero it out and
 * pay the protocol nothing. These tests pin the enforcement.
 */
describe("AGGFlowEntrypointUpgradeable — enforced protocol fee", function () {
  const VAULT_BPS = 5n; // 0.05%
  let entry, router, tokenIn, tokenOut, owner, user, vault, attacker, referrer;

  beforeEach(async function () {
    [owner, user, vault, attacker, referrer] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenIn  = await MockERC20.deploy("In", "IN");
    tokenOut = await MockERC20.deploy("Out", "OUT");

    const Router = await ethers.getContractFactory("MockAGGFlowRouter");
    router = await Router.deploy();

    const Entry = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable");
    entry = await upgrades.deployProxy(
      Entry,
      [owner.address, await router.getAddress(), vault.address, VAULT_BPS],
      { kind: "uups", initializer: "initialize" },
    );

    await tokenIn.mint(user.address, ethers.parseEther("1000"));
    await tokenOut.mint(await router.getAddress(), ethers.parseEther("1000"));
    await router.setOutputAmount(ethers.parseEther("100"));
    await tokenIn.connect(user).approve(await entry.getAddress(), ethers.MaxUint256);
  });

  const intent = async (amt) => ({
    tokenUserBuys: await tokenOut.getAddress(),
    minAmountUserBuys: 0,
    tokenUserSells: await tokenIn.getAddress(),
    amountUserSells: amt,
  });
  const fees = (collector, bps, ref = ethers.ZeroAddress, refBps = 0) => ({
    feeCollectorAddress: collector, feeBps: bps,
    referrerAddress: ref, referrerFeeBps: refBps, isInTokenFee: true,
  });

  it("initializes with the vault as required collector and 5 bps floor", async function () {
    expect(await entry.requiredFeeCollector()).to.equal(vault.address);
    expect(await entry.minFeeBps()).to.equal(VAULT_BPS);
    expect(await entry.owner()).to.equal(owner.address);
    expect(await entry.version()).to.equal("1.0.0");
  });

  it("accepts a swap paying 0.05% to the vault", async function () {
    const amt = ethers.parseEther("100");
    await entry.connect(user).executeSwap(await intent(amt), fees(vault.address, VAULT_BPS), "0x");
    // 0.05% of 100 = 0.05
    expect(await tokenIn.balanceOf(vault.address)).to.equal(ethers.parseEther("0.05"));
  });

  it("REJECTS routing the fee to any other address", async function () {
    const amt = ethers.parseEther("100");
    await expect(
      entry.connect(attacker).executeSwap(await intent(amt), fees(attacker.address, VAULT_BPS), "0x"),
    ).to.be.revertedWithCustomError(entry, "FeeCollectorNotAllowed");
  });

  it("REJECTS a zero protocol fee", async function () {
    const amt = ethers.parseEther("100");
    await expect(
      entry.connect(attacker).executeSwap(await intent(amt), fees(vault.address, 0), "0x"),
    ).to.be.revertedWithCustomError(entry, "FeeBelowMinimum");
  });

  it("REJECTS a fee below the floor", async function () {
    const amt = ethers.parseEther("100");
    await expect(
      entry.connect(attacker).executeSwap(await intent(amt), fees(vault.address, 4), "0x"),
    ).to.be.revertedWithCustomError(entry, "FeeBelowMinimum");
  });

  it("allows paying MORE than the floor", async function () {
    const amt = ethers.parseEther("100");
    await entry.connect(user).executeSwap(await intent(amt), fees(vault.address, 50), "0x");
    expect(await tokenIn.balanceOf(vault.address)).to.equal(ethers.parseEther("0.5"));
  });

  it("still pays referrers alongside the enforced protocol fee", async function () {
    const amt = ethers.parseEther("100");
    await entry.connect(user).executeSwap(
      await intent(amt), fees(vault.address, VAULT_BPS, referrer.address, 20), "0x",
    );
    expect(await tokenIn.balanceOf(vault.address)).to.equal(ethers.parseEther("0.05"));
    expect(await tokenIn.balanceOf(referrer.address)).to.equal(ethers.parseEther("0.2"));
  });

  it("only the owner can change the fee policy", async function () {
    await expect(entry.connect(attacker).setFeePolicy(attacker.address, 0)).to.be.reverted;
    await entry.connect(owner).setFeePolicy(vault.address, 10);
    expect(await entry.minFeeBps()).to.equal(10n);
  });

  it("only the owner can change the router", async function () {
    await expect(entry.connect(attacker).setRouter(attacker.address)).to.be.reverted;
    await entry.connect(owner).setRouter(await router.getAddress());
    expect(await entry.getRouter()).to.equal(await router.getAddress());
  });

  it("is UUPS-upgradeable and keeps its fee policy across the upgrade", async function () {
    const Entry = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable");
    const addr = await entry.getAddress();
    const upgraded = await upgrades.upgradeProxy(addr, Entry, { kind: "uups" });
    expect(await upgraded.getAddress()).to.equal(addr);
    expect(await upgraded.requiredFeeCollector()).to.equal(vault.address);
    expect(await upgraded.minFeeBps()).to.equal(VAULT_BPS);
  });

  it("rejects an upgrade attempted by a non-owner", async function () {
    const EntryAsAttacker = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable", attacker);
    await expect(
      upgrades.upgradeProxy(await entry.getAddress(), EntryAsAttacker, { kind: "uups" }),
    ).to.be.reverted;
  });

  it("policy can be disabled deliberately by the owner", async function () {
    await entry.connect(owner).setFeePolicy(ethers.ZeroAddress, 0);
    const amt = ethers.parseEther("100");
    await entry.connect(user).executeSwap(await intent(amt), fees(attacker.address, 0), "0x");
    expect(await tokenIn.balanceOf(vault.address)).to.equal(0n);
  });
});
