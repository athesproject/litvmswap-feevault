const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

/**
 * Entrypoint 2.0.0 (plan/litvm-team-audit-triage.md, W2):
 *  - ATH-11: the protocol fee goes to the vault, between a minimum and a maximum; the integrator fee is capped.
 *  - ATH-08: fees, the swap and the minimum use what actually arrived and what the receiver actually got.
 *  - Nothing stays in the entrypoint; the 1.0.0 proxy upgrades in place with its storage intact.
 */
describe("AggregatorEntrypoint 2.0.0", function () {
  const MIN_BPS = 5n;
  const MAX_BPS = 100n;
  const MAX_REF_BPS = 500n;
  const SITE_BPS = 15n;
  const E = (n) => ethers.parseEther(String(n));
  let entry, router, tokenIn, tokenOut, owner, user, vault, attacker, referrer, receiver;

  async function deployEntry(routerAddr) {
    const Entry = await ethers.getContractFactory("AggregatorEntrypoint");
    return upgrades.deployProxy(
      Entry,
      [owner.address, routerAddr, vault.address, MIN_BPS, MAX_BPS, MAX_REF_BPS],
      { kind: "uups", initializer: "initialize" },
    );
  }

  beforeEach(async function () {
    [owner, user, vault, attacker, referrer, receiver] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenIn = await MockERC20.deploy("In", "IN");
    tokenOut = await MockERC20.deploy("Out", "OUT");
    router = await (await ethers.getContractFactory("MockAGGFlowRouter")).deploy();
    entry = await deployEntry(await router.getAddress());

    await tokenIn.mint(user.address, E(1000));
    await tokenOut.mint(await router.getAddress(), E(1000));
    await router.setOutputAmount(E(100));
    await tokenIn.connect(user).approve(await entry.getAddress(), ethers.MaxUint256);
  });

  const intent = async (amt, min = 0n, sell = tokenIn, buy = tokenOut) => ({
    tokenUserBuys: buy === null ? ethers.ZeroAddress : await buy.getAddress(),
    minAmountUserBuys: min,
    tokenUserSells: sell === null ? ethers.ZeroAddress : await sell.getAddress(),
    amountUserSells: amt,
  });
  const fees = (bps = SITE_BPS, inToken = false, ref = ethers.ZeroAddress, refBps = 0n, collector) => ({
    feeCollectorAddress: collector ?? vault.address, feeBps: bps,
    referrerAddress: ref, referrerFeeBps: refBps, isInTokenFee: inToken,
  });

  describe("setup and admin", function () {
    it("initializes policy and caps", async function () {
      expect(await entry.version()).to.equal("2.0.0");
      expect(await entry.owner()).to.equal(owner.address);
      expect(await entry.getRouter()).to.equal(await router.getAddress());
      expect(await entry.requiredFeeCollector()).to.equal(vault.address);
      expect(await entry.minFeeBps()).to.equal(MIN_BPS);
      expect(await entry.maxFeeBps()).to.equal(MAX_BPS);
      expect(await entry.maxReferrerFeeBps()).to.equal(MAX_REF_BPS);
    });

    it("only the owner changes the router, policy and caps", async function () {
      await expect(entry.connect(attacker).setRouter(await router.getAddress()))
        .to.be.revertedWithCustomError(entry, "OwnableUnauthorizedAccount");
      await expect(entry.connect(attacker).setFeePolicy(attacker.address, 0))
        .to.be.revertedWithCustomError(entry, "OwnableUnauthorizedAccount");
      await expect(entry.connect(attacker).setFeeCaps(10000, 0))
        .to.be.revertedWithCustomError(entry, "OwnableUnauthorizedAccount");
      await expect(entry.connect(attacker).initializeV2(1, 1)).to.be.reverted;
    });

    it("refuses a router without code and inconsistent fee settings", async function () {
      await expect(entry.setRouter(attacker.address)).to.be.revertedWithCustomError(entry, "InvalidRouter");
      await expect(entry.setFeePolicy(vault.address, MAX_BPS + 1n)).to.be.revertedWithCustomError(entry, "InvalidFeeStructure");
      await expect(entry.setFeeCaps(MIN_BPS - 1n, 0)).to.be.revertedWithCustomError(entry, "InvalidFeeStructure");
      await expect(entry.setFeeCaps(9000, 1001)).to.be.revertedWithCustomError(entry, "InvalidFeeStructure");
      await expect(entry.setFeeCaps(200, 300)).to.emit(entry, "FeeCapsUpdated").withArgs(200, 300);
    });

    it("cannot be initialized twice", async function () {
      await expect(entry.initialize(attacker.address, await router.getAddress(), attacker.address, 0, 0, 0))
        .to.be.revertedWithCustomError(entry, "InvalidInitialization");
    });
  });

  describe("ATH-11: fee policy", function () {
    it("pays the site's 0.15% output fee to the vault", async function () {
      await entry.connect(user).executeSwap(await intent(E(10)), fees(), "0x");
      expect(await tokenOut.balanceOf(vault.address)).to.equal(E(100) * SITE_BPS / 10000n);
      expect(await tokenOut.balanceOf(user.address)).to.equal(E(100) - E(100) * SITE_BPS / 10000n);
    });

    it("takes an input fee from what arrived", async function () {
      await entry.connect(user).executeSwap(await intent(E(10)), fees(SITE_BPS, true), "0x");
      expect(await tokenIn.balanceOf(vault.address)).to.equal(E(10) * SITE_BPS / 10000n);
      expect(await tokenIn.balanceOf(await router.getAddress())).to.equal(E(10) - E(10) * SITE_BPS / 10000n);
    });

    it("refuses another collector, a fee below the floor and a fee above the cap", async function () {
      await expect(entry.connect(attacker).executeSwap(await intent(E(1)), fees(SITE_BPS, false, ethers.ZeroAddress, 0n, attacker.address), "0x"))
        .to.be.revertedWithCustomError(entry, "FeeCollectorNotAllowed");
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(0n), "0x"))
        .to.be.revertedWithCustomError(entry, "FeeBelowMinimum");
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(MAX_BPS + 1n), "0x"))
        .to.be.revertedWithCustomError(entry, "FeeAboveMaximum");
    });

    it("caps the integrator fee and requires a recipient for it", async function () {
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(SITE_BPS, false, referrer.address, MAX_REF_BPS + 1n), "0x"))
        .to.be.revertedWithCustomError(entry, "ReferrerFeeAboveMaximum");
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(SITE_BPS, false, ethers.ZeroAddress, 10n), "0x"))
        .to.be.revertedWithCustomError(entry, "InvalidReferrer");
      // The partner API's maximum (5%) is accepted.
      await entry.connect(user).executeSwap(await intent(E(1)), fees(SITE_BPS, false, referrer.address, MAX_REF_BPS), "0x");
      expect(await tokenOut.balanceOf(referrer.address)).to.equal(E(100) * MAX_REF_BPS / 10000n);
    });
  });

  describe("ATH-08: measured amounts", function () {
    let fot;
    beforeEach(async function () {
      fot = await (await ethers.getContractFactory("FeeOnTransferERC20")).deploy();
      await fot.mint(user.address, E(1000));
      await fot.connect(user).approve(await entry.getAddress(), ethers.MaxUint256);
      await fot.mint(await router.getAddress(), E(1000));
    });

    it("bases the input fee and the swap on what arrived, and reports it", async function () {
      const sent = E(100);
      const arrived = sent - sent / 100n;
      const fee = arrived * SITE_BPS / 10000n;
      const routerBefore = await fot.balanceOf(await router.getAddress());
      await expect(entry.connect(user).executeSwap(await intent(sent, 0n, fot, tokenOut), fees(SITE_BPS, true), "0x"))
        .to.emit(entry, "AGGFlowSwap")
        .withArgs(user.address, ethers.ZeroAddress, await fot.getAddress(), await tokenOut.getAddress(), true, arrived, E(100), 0, SITE_BPS);
      // The router was asked for exactly what was left after the fee, and the entrypoint keeps nothing.
      const pulled = arrived - fee;
      expect(await fot.balanceOf(await router.getAddress()) - routerBefore).to.equal(pulled - pulled / 100n);
      expect(await fot.balanceOf(await entry.getAddress())).to.equal(0);
    });

    it("checks the minimum against what the receiver got", async function () {
      await router.setOutputAmount(E(100));
      const produced = E(100) - E(100) / 100n; // the entrypoint receives 99% of what the router sends
      const afterFee = produced - produced * SITE_BPS / 10000n;
      const got = afterFee - afterFee / 100n; // and the user 99% of what the entrypoint sends
      await expect(entry.connect(user).executeSwap(await intent(E(1), got + 1n, tokenIn, fot), fees(), "0x"))
        .to.be.revertedWithCustomError(entry, "InsufficientAmountAfterFees");
      const before = await fot.balanceOf(user.address);
      await entry.connect(user).executeSwap(await intent(E(1), got, tokenIn, fot), fees(), "0x");
      expect(await fot.balanceOf(user.address) - before).to.equal(got);
      expect(await fot.balanceOf(await entry.getAddress())).to.equal(0);
    });
  });

  describe("nothing stays in the entrypoint", function () {
    it("never spends or pays out tokens that were already there", async function () {
      await tokenIn.mint(await entry.getAddress(), E(50));
      await tokenOut.mint(await entry.getAddress(), E(70));
      await entry.connect(user).executeSwap(await intent(E(10)), fees(), "0x");
      expect(await tokenIn.balanceOf(await entry.getAddress())).to.equal(E(50));
      expect(await tokenOut.balanceOf(await entry.getAddress())).to.equal(E(70));
      expect(await tokenOut.balanceOf(user.address)).to.equal(E(100) - E(100) * SITE_BPS / 10000n);
    });

    it("reverts if the router leaves input behind", async function () {
      const lazy = await (await ethers.getContractFactory("PartialPullRouter")).deploy();
      await tokenOut.mint(await lazy.getAddress(), E(1000));
      await lazy.setOutputAmount(E(1));
      await entry.setRouter(await lazy.getAddress());
      await expect(entry.connect(user).executeSwap(await intent(E(10)), fees(), "0x"))
        .to.be.revertedWithCustomError(entry, "InputNotSpent");
    });

    it("refuses re-entry from the router", async function () {
      const evil = await (await ethers.getContractFactory("ReenteringRouter")).deploy();
      await entry.setRouter(await evil.getAddress());
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(), "0x"))
        .to.be.revertedWithCustomError(entry, "ReentrancyGuardReentrantCall");
    });
  });

  describe("native token and receivers", function () {
    it("native in: refunds the excess and leaves nothing", async function () {
      const routerAddr = await router.getAddress();
      const before = await ethers.provider.getBalance(routerAddr);
      await entry.connect(user).executeSwap(await intent(E(1), 0n, null, tokenOut), fees(), "0x", { value: E(3) });
      expect(await ethers.provider.getBalance(routerAddr) - before).to.equal(E(1));
      expect(await ethers.provider.getBalance(await entry.getAddress())).to.equal(0);
    });

    it("native out: pays the receiver after the fee", async function () {
      await owner.sendTransaction({ to: await router.getAddress(), value: E(200) });
      const before = await ethers.provider.getBalance(receiver.address);
      const vaultBefore = await ethers.provider.getBalance(vault.address);
      await entry.connect(user).executeSwapWithReceiver(await intent(E(10), 0n, tokenIn, null), fees(), "0x", receiver.address);
      expect(await ethers.provider.getBalance(receiver.address) - before).to.equal(E(100) - E(100) * SITE_BPS / 10000n);
      expect(await ethers.provider.getBalance(vault.address) - vaultBefore).to.equal(E(100) * SITE_BPS / 10000n);
      expect(await ethers.provider.getBalance(await entry.getAddress())).to.equal(0);
    });

    it("refuses native with a token sale, direct native sends and a bad receiver", async function () {
      await expect(entry.connect(user).executeSwap(await intent(E(1)), fees(), "0x", { value: 1 }))
        .to.be.revertedWithCustomError(entry, "UnexpectedNativeValue");
      await expect(user.sendTransaction({ to: await entry.getAddress(), value: 1 }))
        .to.be.revertedWithCustomError(entry, "NativeNotAccepted");
      await expect(entry.connect(user).executeSwapWithReceiver(await intent(E(1)), fees(), "0x", ethers.ZeroAddress))
        .to.be.revertedWithCustomError(entry, "InvalidReceiver");
      await expect(entry.connect(user).executeSwapWithReceiver(await intent(E(1)), fees(), "0x", await entry.getAddress()))
        .to.be.revertedWithCustomError(entry, "InvalidReceiver");
      await expect(entry.connect(user).executeSwap(await intent(0n), fees(), "0x"))
        .to.be.revertedWithCustomError(entry, "NothingReceived");
    });
  });

  describe("upgrade from 1.0.0", function () {
    it("keeps owner, router and fee policy, adds the caps once", async function () {
      const Old = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable");
      const proxy = await upgrades.deployProxy(Old, [owner.address, await router.getAddress(), vault.address, MIN_BPS], { kind: "uups" });
      expect(await proxy.version()).to.equal("1.0.0");

      const New = await ethers.getContractFactory("AggregatorEntrypoint");
      const upgraded = await upgrades.upgradeProxy(await proxy.getAddress(), New, {
        kind: "uups",
        call: { fn: "initializeV2", args: [MAX_BPS, MAX_REF_BPS] },
      });
      expect(await upgraded.version()).to.equal("2.0.0");
      expect(await upgraded.owner()).to.equal(owner.address);
      expect(await upgraded.getRouter()).to.equal(await router.getAddress());
      expect(await upgraded.requiredFeeCollector()).to.equal(vault.address);
      expect(await upgraded.minFeeBps()).to.equal(MIN_BPS);
      expect(await upgraded.maxFeeBps()).to.equal(MAX_BPS);
      expect(await upgraded.maxReferrerFeeBps()).to.equal(MAX_REF_BPS);
      await expect(upgraded.initializeV2(1, 1)).to.be.revertedWithCustomError(upgraded, "InvalidInitialization");
      await expect(upgraded.initialize(attacker.address, await router.getAddress(), attacker.address, 0, 0, 0))
        .to.be.revertedWithCustomError(upgraded, "InvalidInitialization");

      await tokenIn.connect(user).approve(await upgraded.getAddress(), ethers.MaxUint256);
      await upgraded.connect(user).executeSwap(await intent(E(10)), fees(), "0x");
      expect(await tokenOut.balanceOf(vault.address)).to.equal(E(100) * SITE_BPS / 10000n);
    });

    it("storage layout is compatible (OpenZeppelin check)", async function () {
      const Old = await ethers.getContractFactory("AGGFlowEntrypointUpgradeable");
      const New = await ethers.getContractFactory("AggregatorEntrypoint");
      await upgrades.validateUpgrade(Old, New, { kind: "uups" });
    });
  });
});
