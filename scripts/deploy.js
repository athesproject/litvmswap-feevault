const { ethers, upgrades } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("----------------------------------------------------");
  console.log("Deploying DexFeeVaultUpgradeable with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Define initial beneficiary structure (Total BPS must equal 10,000)
  const partnerId = ethers.keccak256(ethers.toUtf8Bytes("PARTNERS"));
  const coreId = ethers.keccak256(ethers.toUtf8Bytes("CORE"));
  const treasuryId = ethers.keccak256(ethers.toUtf8Bytes("TREASURY"));

  const partnerWallet = process.env.PARTNER_WALLET || deployer.address;
  const coreWallet = process.env.CORE_WALLET || deployer.address;
  const treasuryWallet = process.env.TREASURY_WALLET || deployer.address;

  const initialBeneficiaries = [
    { id: partnerId, wallet: partnerWallet, bps: 4000, name: "Partners" },
    { id: coreId, wallet: coreWallet, bps: 3500, name: "Core Team" },
    { id: treasuryId, wallet: treasuryWallet, bps: 2500, name: "Treasury & Ecosystem" },
  ];

  const allowPublicDistribution = true;

  console.log("Deploying UUPS Proxy...");
  const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
  const vaultProxy = await upgrades.deployProxy(
    DexFeeVault,
    [deployer.address, initialBeneficiaries, allowPublicDistribution],
    {
      kind: "uups",
      initializer: "initialize",
    }
  );

  await vaultProxy.waitForDeployment();
  const proxyAddress = await vaultProxy.getAddress();
  const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("----------------------------------------------------");
  console.log("SUCCESS! DexFeeVaultUpgradeable Deployed Successfully!");
  console.log("Proxy Address:         ", proxyAddress);
  console.log("Implementation Address:", implAddress);
  console.log("Contract Version:      ", await vaultProxy.version());
  console.log("Total Allocated BPS:   ", (await vaultProxy.totalBps()).toString(), "/ 10000");

  // Optional: Auto-register V3 position manager if provided
  const v3Manager = process.env.V3_POSITION_MANAGER || "0x1089f046B597f259BeFDC15Bf9C90E33616BA366";
  if (ethers.isAddress(v3Manager)) {
    console.log(`Auto-registering V3 Position Manager: ${v3Manager}`);
    await (await vaultProxy.addV3Manager(v3Manager)).wait();
    console.log("V3 Position Manager registered!");
  }

  // Optional: Auto-register default distribution token (e.g. WETH)
  const wethToken = process.env.WETH_ADDRESS || "0x23a35f79A57c6bF5f963a8aB290076aD13E678d1";
  if (ethers.isAddress(wethToken)) {
    console.log(`Auto-registering WETH distribution token: ${wethToken}`);
    await (await vaultProxy.addDistributionToken(wethToken)).wait();
    console.log("Distribution token registered!");
  }

  console.log("----------------------------------------------------");
  console.log("Vault is ready for production!");
  console.log("Update VAULT_ADDRESS in frontend contracts.js & keeper .env with proxy address:", proxyAddress);
  console.log("----------------------------------------------------");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
