const { ethers, upgrades } = require("hardhat");

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS || "0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10";

  const [deployer] = await ethers.getSigners();
  console.log("----------------------------------------------------");
  console.log("Upgrading DexFeeVault Proxy at address:", proxyAddress);
  console.log("Upgrader account:", deployer.address);

  const DexFeeVault = await ethers.getContractFactory("DexFeeVaultUpgradeable");
  
  console.log("Validating and deploying new implementation...");
  const upgradedVault = await upgrades.upgradeProxy(proxyAddress, DexFeeVault, {
    kind: "uups",
  });

  await upgradedVault.waitForDeployment();
  const newImplAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);

  console.log("----------------------------------------------------");
  console.log("SUCCESS! Proxy upgraded successfully!");
  console.log("Proxy Address:             ", proxyAddress);
  console.log("New Implementation Address:", newImplAddress);
  console.log("New Contract Version:      ", await upgradedVault.version());
  console.log("----------------------------------------------------");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Upgrade failed:", error);
    process.exit(1);
  });
