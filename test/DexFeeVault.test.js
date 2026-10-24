const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");

describe("DexFeeVaultUpgradeable - Complete Test Suite", function () {
  let vault;
  let mockTokenA, mockTokenB, wrappedNative;
  let mockV3Manager;
  let mockV2Pair;

  let owner, partner, core, treasury, bot, stranger;
  let partnerId, coreId, treasuryId;

  beforeEach(async function () {
    [owner, partner, core, treasury, bot, stranger] = await ethers.getSigners();

    // Deploy Mock ERC20 Tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    mockTokenA = await MockERC20.deploy("Token A", "TKNA");
    await mockTokenA.waitForDeployment();

    mockTokenB = await MockERC20.deploy("Token B", "TKNB");
    await mockTokenB.waitForDeployment();

    // Deploy Mock V3 Position Manager & V2 Pair
    const MockV3 = await ethers.getContractFactory("MockUniswapV3PositionManager");
    mockV3Manager = await MockV3.deploy(await mockTokenA.getAddress(), await mockTokenB.getAddress());
    await mockV3Manager.waitForDeployment();

    const MockV2 = await ethers.getContractFactory("MockUniswapV2Pair");
    mockV2Pair = await MockV2.deploy(await mockTokenA.getAddress(), await mockTokenB.getAddress());
    await mockV2Pair.waitForDeployment();

    // Transfer mock tokens to mock V3 manager and mock V2 pair for fee collection tests
    await mockTokenA.mint(await mockV3Manager.getAddress(), ethers.parseEther("10000"));
    await mockTokenB.mint(await mockV3Manager.getAddress(), ethers.parseEther("10000"));

    await mockTokenA.mint(await mockV2Pair.getAddress(), ethers.parseEther("5000"));
    await mockTokenB.mint(await mockV2Pair.getAddress(), ethers.parseEther("5000"));

    // Prepare Beneficiaries (Partners 40%, Core 35%, Treasury 25% = 100%)
    partnerId = ethers.keccak256(ethers.toUtf8Bytes("PARTNERS"));
    coreId = ethers.keccak256(ethers.toUtf8Bytes("CORE"));
    treasuryId = ethers.keccak256(ethers.toUtf8Bytes("TREASURY"));

    const initialBeneficiaries = [
      { id: partnerId, wallet: partner.address, bps: 4000, name: "Partners" },
      { id: coreId, wallet: core.address, bps: 3500, name: "Core Team" },
      { id: treasuryId, wallet: treasury.address, bps: 2500, name: "Treasury" },
    ];

    // Deploy DexFeeVaultUpgradeable UUPS Proxy (v2.9: the wrapped native token is set at initialization;
    // a token no test moves, so revenue attribution behaves as before)
    wrappedNative = await MockERC20.deploy("Wrapped Native", "WNATIVE");
    const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
    vault = await upgrades.deployProxy(
      DexFeeVault,
      [owner.address, initialBeneficiaries, true, await wrappedNative.getAddress()],
      { kind: "uups", initializer: "initialize" }
    );
    await vault.waitForDeployment();

    // Grant BOT_ROLE to bot signer
    const BOT_ROLE = await vault.BOT_ROLE();
    await vault.grantRole(BOT_ROLE, bot.address);
  });

  describe("1. Initialization & Role Setup", function () {
    it("should correctly initialize state variables and roles", async function () {
      // Asserted as a floor, not an exact string: pinning the version here means
      // every release bump breaks an unrelated initialization test.
      const [maj, min] = (await vault.version()).split(".").map(Number);
      expect(maj > 2 || (maj === 2 && min >= 6), "version must be >= 2.6.0").to.be.true;
      expect(await vault.totalBps()).to.equal(10000);
      expect(await vault.publicDistributionAllowed()).to.be.true;

      const DEFAULT_ADMIN_ROLE = await vault.DEFAULT_ADMIN_ROLE();
      expect(await vault.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;

      const pBeneficiary = await vault.getBeneficiary(partnerId);
      expect(pBeneficiary.wallet).to.equal(partner.address);
      expect(pBeneficiary.bps).to.equal(4000);
      expect(pBeneficiary.isActive).to.be.true;
    });

    it("should prevent re-initialization", async function () {
      await expect(
        vault.initialize(owner.address, [], false, await wrappedNative.getAddress())
      ).to.be.revertedWithCustomError(vault, "InvalidInitialization");
    });
  });

  describe("2. Fee Deposit Mechanisms", function () {
    it("should receive native ETH via direct transfer and emit event", async function () {
      const depositAmount = ethers.parseEther("1.5");
      await expect(
        owner.sendTransaction({
          to: await vault.getAddress(),
          value: depositAmount,
        })
      )
        .to.emit(vault, "FeeReceived")
        .withArgs(owner.address, depositAmount);

      expect(await ethers.provider.getBalance(await vault.getAddress())).to.equal(depositAmount);
    });

    it("should accept ERC20 fee deposits via depositAggregatorFee", async function () {
      const depositAmount = ethers.parseEther("500");
      await mockTokenA.approve(await vault.getAddress(), depositAmount);

      await expect(vault.depositAggregatorFee(await mockTokenA.getAddress(), depositAmount, "0x"))
        .to.emit(vault, "FeeDeposited")
        .withArgs(await mockTokenA.getAddress(), owner.address, depositAmount);

      expect(await mockTokenA.balanceOf(await vault.getAddress())).to.equal(depositAmount);
    });

    it("should accept Aggregator fees for native ETH and ERC20 tokens", async function () {
      const ethAmount = ethers.parseEther("2.0");
      await expect(
        vault.depositAggregatorFee(ethers.ZeroAddress, ethAmount, "0x1234", { value: ethAmount })
      )
        .to.emit(vault, "FeeReceived")
        .withArgs(owner.address, ethAmount);

      const tokenAmount = ethers.parseEther("300");
      await mockTokenB.approve(await vault.getAddress(), tokenAmount);
      await expect(
        vault.depositAggregatorFee(await mockTokenB.getAddress(), tokenAmount, "0x5678")
      )
        .to.emit(vault, "FeeDeposited")
        .withArgs(await mockTokenB.getAddress(), owner.address, tokenAmount);
    });
  });

  describe("3. Uniswap V3 & V2 Fee Collection", function () {
    it("v2.8 removes the full sweep and the manual collectors (selective calls replace them)", async function () {
      // harvest()/harvestAndDistribute() looped every registered source (far beyond a block on LitVM);
      // collectUniswapV3Fees/collectUniswapV2Fees are covered by collectV3Positions/redeemV2LpTokens.
      for (const name of ["harvest", "harvestAndDistribute", "collectUniswapV3Fees", "collectUniswapV2Fees", "distributeBatch", "getStreamStats"]) {
        expect(vault.interface.getFunction(name), name).to.equal(null);
      }
      for (const name of ["collectV3ProtocolFees", "collectV3Positions", "redeemV2LpTokens", "distributeRegistered", "claimFor", "enableProtocolFee"]) {
        expect(vault.interface.getFunction(name), name).to.not.equal(null);
      }
    });

    it("should allow registering V2 pairs, V3 managers, and distribution tokens", async function () {
      const pairAddr = await mockV2Pair.getAddress();
      const managerAddr = await mockV3Manager.getAddress();
      const tokenAAddr = await mockTokenA.getAddress();

      await vault.addV2Pair(pairAddr);
      await vault.addV3Manager(managerAddr);
      await vault.addDistributionToken(tokenAAddr);

      expect(await vault.getRegisteredV2Pairs()).to.include(pairAddr);
      expect(await vault.getRegisteredV3Managers()).to.include(managerAddr);
      expect(await vault.getRegisteredDistributionTokens()).to.include(tokenAAddr);
    });

    it("distributeRegistered splits ETH and every registered token", async function () {
      const tokenA = await mockTokenA.getAddress();
      await vault.addDistributionToken(tokenA);
      await mockTokenA.mint(await vault.getAddress(), ethers.parseEther("100"));
      await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1") });
      await vault.distributeRegistered(false);
      expect(await vault.pendingTokens(tokenA, partner.address)).to.equal(ethers.parseEther("40"));
      expect(await vault.pendingETH(treasury.address)).to.equal(ethers.parseEther("0.25"));
    });
  });

  describe("4. Dynamic BPS Beneficiary Management", function () {
    it("should allow FEE_MANAGER to change the split in one call (v2.9 replaceBeneficiaries)", async function () {
      await vault.replaceBeneficiaries([
        { id: partnerId, wallet: partner.address, bps: 5000, name: "Partners V2" },
        { id: coreId, wallet: core.address, bps: 2500, name: "Core Team V2" },
        { id: treasuryId, wallet: treasury.address, bps: 2500, name: "Treasury" },
      ]);

      expect(await vault.totalBps()).to.equal(10000);
      const p = await vault.getBeneficiary(partnerId);
      expect(p.bps).to.equal(5000);
    });

    it("should change one wallet with setBeneficiary, but never leave the split below or above 100%", async function () {
      await vault.setBeneficiary(coreId, stranger.address, 3500, "Core Team");
      expect((await vault.getBeneficiary(coreId)).wallet).to.equal(stranger.address);
      await expect(vault.setBeneficiary(coreId, core.address, 2500, "Core Team"))
        .to.be.revertedWithCustomError(vault, "InvalidBpsTotal");
      await expect(vault.setBeneficiary(partnerId, partner.address, 6000, "Excess Partners"))
        .to.be.revertedWithCustomError(vault, "InvalidBpsTotal");
      expect(await vault.totalBps()).to.equal(10000);
    });

    it("should remove a beneficiary by leaving it out of the new split", async function () {
      await vault.replaceBeneficiaries([
        { id: partnerId, wallet: partner.address, bps: 6000, name: "Partners" },
        { id: coreId, wallet: core.address, bps: 4000, name: "Core Team" },
      ]);

      expect(await vault.totalBps()).to.equal(10000);
      const t = await vault.getBeneficiary(treasuryId);
      expect(t.isActive).to.be.false;
      expect(await vault.getAllBeneficiaryIds()).to.deep.equal([partnerId, coreId]);
    });

    it("should refuse a new split that is not exactly 100%", async function () {
      await expect(vault.replaceBeneficiaries([
        { id: partnerId, wallet: partner.address, bps: 6000, name: "Partners" },
      ])).to.be.revertedWithCustomError(vault, "InvalidBpsTotal");
      await expect(vault.connect(stranger).replaceBeneficiaries([]))
        .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });

    it("should revert when non-FEE_MANAGER attempts setting beneficiary", async function () {
      const FEE_MANAGER_ROLE = await vault.FEE_MANAGER_ROLE();
      await expect(
        vault.connect(stranger).setBeneficiary(partnerId, stranger.address, 1000, "Hacker")
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });

  describe("5. Fee Distribution (Push & Pull Claims)", function () {
    it("should distribute native ETH with autoPush directly to beneficiary wallets", async function () {
      const depositAmount = ethers.parseEther("10.0");
      await owner.sendTransaction({ to: await vault.getAddress(), value: depositAmount });

      const partnerBalBefore = await ethers.provider.getBalance(partner.address);
      const coreBalBefore = await ethers.provider.getBalance(core.address);
      const treasuryBalBefore = await ethers.provider.getBalance(treasury.address);

      // Trigger distribution (AutoPush = true)
      await vault.distributeETH(true);

      const partnerBalAfter = await ethers.provider.getBalance(partner.address);
      const coreBalAfter = await ethers.provider.getBalance(core.address);
      const treasuryBalAfter = await ethers.provider.getBalance(treasury.address);

      // 40% of 10 ETH = 4 ETH
      expect(partnerBalAfter - partnerBalBefore).to.equal(ethers.parseEther("4.0"));
      // 35% of 10 ETH = 3.5 ETH
      expect(coreBalAfter - coreBalBefore).to.equal(ethers.parseEther("3.5"));
      // 25% of 10 ETH = 2.5 ETH
      expect(treasuryBalAfter - treasuryBalBefore).to.equal(ethers.parseEther("2.5"));
    });

    it("should deposit tokens to pending claim balance when autoPush = false", async function () {
      const depositAmount = ethers.parseEther("1000");
      await mockTokenA.mint(await vault.getAddress(), depositAmount);

      // Distribute with autoPush = false
      await vault.distributeToken(await mockTokenA.getAddress(), false);

      const pendingPartner = await vault.pendingTokens(await mockTokenA.getAddress(), partner.address);
      expect(pendingPartner).to.equal(ethers.parseEther("400")); // 40%

      // Partner claims pending tokens
      await vault.connect(partner).claimToken(await mockTokenA.getAddress());
      expect(await mockTokenA.balanceOf(partner.address)).to.equal(ethers.parseEther("400"));

      // Pending balance should reset to 0
      expect(await vault.pendingTokens(await mockTokenA.getAddress(), partner.address)).to.equal(0);
    });

    it("should distribute several tokens and ETH, then claim them all at once", async function () {
      const ethAmount = ethers.parseEther("4.0");
      const tokenAAmount = ethers.parseEther("2000");
      const tokenBAmount = ethers.parseEther("1000");

      await owner.sendTransaction({ to: await vault.getAddress(), value: ethAmount });
      await mockTokenA.mint(await vault.getAddress(), tokenAAmount);
      await mockTokenB.mint(await vault.getAddress(), tokenBAmount);

      const tokens = [await mockTokenA.getAddress(), await mockTokenB.getAddress()];
      await vault.distributeETH(false);
      for (const t of tokens) await vault.distributeToken(t, false);

      // Check partner claimable balances
      expect(await vault.pendingETH(partner.address)).to.equal(ethers.parseEther("1.6")); // 40% of 4 ETH
      expect(await vault.pendingTokens(await mockTokenA.getAddress(), partner.address)).to.equal(ethers.parseEther("800"));

      // Partner claims all
      await vault.connect(partner).claimAll(tokens, true);
      expect(await mockTokenA.balanceOf(partner.address)).to.equal(ethers.parseEther("800"));
      expect(await vault.pendingETH(partner.address)).to.equal(0);
    });
  });

  describe("6. Pause & Access Control Controls", function () {
    it("should prevent distributions when paused", async function () {
      await vault.pause();
      await expect(vault.distributeETH(true)).to.be.revertedWithCustomError(vault, "EnforcedPause");

      await vault.unpause();
      // Should succeed after unpausing
      await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1.0") });
      await expect(vault.distributeETH(true)).to.not.be.reverted;
    });

    it("should restrict distribution if public distribution is disabled and caller lacks role", async function () {
      await vault.setPublicDistributionAllowed(false);

      await owner.sendTransaction({ to: await vault.getAddress(), value: ethers.parseEther("1.0") });
      await expect(
        vault.connect(stranger).distributeETH(true)
      ).to.be.revertedWithCustomError(vault, "DistributionNotAllowed");

      // Authorized bot should still be allowed
      await expect(vault.connect(bot).distributeETH(true)).to.not.be.reverted;
    });
  });

  describe("7. Emergency Rescue", function () {
    it("should allow DEFAULT_ADMIN to rescue stuck tokens or ETH", async function () {
      const depositAmount = ethers.parseEther("500");
      await mockTokenA.mint(await vault.getAddress(), depositAmount);

      await vault.emergencyWithdraw(await mockTokenA.getAddress(), owner.address, depositAmount);
      expect(await mockTokenA.balanceOf(owner.address)).to.be.gte(depositAmount);
    });
  });

  describe("8. UUPS Proxy Contract Upgradeability", function () {
    it("should successfully upgrade to DexFeeVaultV2Mock while preserving state", async function () {
      const depositAmount = ethers.parseEther("100");
      await mockTokenA.mint(await vault.getAddress(), depositAmount);
      await vault.distributeToken(await mockTokenA.getAddress(), false);

      const pendingPartnerBefore = await vault.pendingTokens(await mockTokenA.getAddress(), partner.address);

      // Perform UUPS upgrade to V2 Mock
      const DexFeeVaultV2Mock = await ethers.getContractFactory("DexFeeVaultV2Mock");
      const upgradedVault = await upgrades.upgradeProxy(await vault.getAddress(), DexFeeVaultV2Mock, {
        kind: "uups",
      });

      // Verify version upgraded to 2.0.0
      expect(await upgradedVault.version()).to.equal("2.0.0");

      // Verify original state preserved
      expect(await upgradedVault.totalBps()).to.equal(10000);
      expect(
        await upgradedVault.pendingTokens(await mockTokenA.getAddress(), partner.address)
      ).to.equal(pendingPartnerBefore);

      // Call new V2 specific function
      await upgradedVault.setCustomV2Variable(42);
      expect(await upgradedVault.customV2Variable()).to.equal(42);
    });

    it("should reject upgrade attempts by non-UPGRADER role", async function () {
      const DexFeeVaultV2Mock = await ethers.getContractFactory("DexFeeVaultV2Mock");
      const v2Impl = await DexFeeVaultV2Mock.deploy();
      await v2Impl.waitForDeployment();

      await expect(
        vault.connect(stranger).upgradeToAndCall(await v2Impl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount");
    });
  });
});
