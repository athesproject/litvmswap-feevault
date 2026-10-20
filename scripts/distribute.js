const { ethers } = require("hardhat");

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!proxyAddress) {
    throw new Error("Please provide PROXY_ADDRESS in your environment.");
  }

  const [caller] = await ethers.getSigners();
  console.log("----------------------------------------------------");
  console.log("Triggering fee distribution on DexFeeVault:", proxyAddress);
  console.log("Caller account:", caller.address);

  const vault = await ethers.getContractAt("DexFeeVaultUpgradeable", proxyAddress);

  // Check ETH balance
  const ethBalance = await ethers.provider.getBalance(proxyAddress);
  console.log("Vault ETH Balance:", ethers.formatEther(ethBalance));

  const autoPush = process.env.AUTO_PUSH === "true"; // Push or deposit to claimable balances

  if (ethBalance > 0n) {
    console.log(`Distributing ETH fees (AutoPush: ${autoPush})...`);
    const tx = await vault.distributeETH(autoPush);
    await tx.wait();
    console.log("ETH distribution tx complete:", tx.hash);
  }

  const tokensToDistribute = process.env.TOKEN_ADDRESSES ? process.env.TOKEN_ADDRESSES.split(",") : [];
  if (tokensToDistribute.length > 0) {
    console.log(`Distributing token fees for ${tokensToDistribute.length} tokens...`);
    const tx = await vault.distributeBatch(tokensToDistribute, false, autoPush);
    await tx.wait();
    console.log("Token batch distribution tx complete:", tx.hash);
  }

  console.log("----------------------------------------------------");
  console.log("Fee distribution run completed.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Distribution failed:", error);
    process.exit(1);
  });
