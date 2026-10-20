# Dex Fee Vault - Upgradeable Smart Contract Suite

An enterprise-grade, gas-optimized, and **Upgradeable (UUPS / ERC-1967)** DEX Fee Vault built for LitVM and EVM chains. It aggregates protocol revenue from **Uniswap V2**, **Uniswap V3**, and **Swap Aggregators**, automatically allocating and distributing funds to **Partners**, **Core Team**, **Treasury**, and other dynamic stakeholders using customizable basis point (BPS) allocations.

---

## 🌟 Key Features

1. **Upgradeable Architecture (UUPS Proxy)**:
   - Built on OpenZeppelin `UUPSUpgradeable` (EIP-1967) for maximum gas efficiency and seamless logic upgrades without altering vault address or state storage.
   - Storage gap protection (`__gap`) for safe future contract state extensions.

2. **Multi-Source DEX Fee Aggregation**:
   - **Uniswap V3**: Direct liquidity fee harvesting via `collectUniswapV3Fees` targeting NFT position manager IDs.
   - **Uniswap V2**: Direct pair fee skimming and token deposits via `collectUniswapV2Fees`.
   - **Swap Aggregator**: Instant native ETH & ERC-20 fee ingestion via `depositAggregatorFee` with routing metadata logs.
   - **Native ETH**: Direct fallback and receive hooks.

3. **Dynamic Percentage Allocation (BPS System)**:
   - Configurable percentage shares based on Basis Points ($10,000 \text{ BPS} = 100.00\%$).
   - Granular role permissioning (`FEE_MANAGER_ROLE`) for modifying shares (e.g. Partners, Core, Treasury, Staking).
   - Strict validation ensuring active allocation total equals exactly 10,000 BPS before distribution.

4. **Flexible Fee Distribution (Push & Pull Claim Modes)**:
   - **Push Mode (`autoPush = true`)**: Automatically transfers ETH/tokens directly to partner and core team wallets.
   - **Pull Mode (`autoPush = false`)**: Safely updates `pendingTokens` and `pendingETH` claim balances per beneficiary, preventing gas limit bottlenecks and protecting recipient wallets.
   - **Batching**: `distributeBatch` allows triggering multi-token & ETH distribution in a single atomic transaction.

5. **Security & Access Control**:
   - Role-Based Access Control (`AccessControlUpgradeable`): `DEFAULT_ADMIN_ROLE`, `FEE_MANAGER_ROLE`, `UPGRADER_ROLE`, `PAUSER_ROLE`, `BOT_ROLE`.
   - Re-entrancy protection (`ReentrancyGuardUpgradeable`) on all deposits, claims, and distributions.
   - Emergency emergency pause (`PausableUpgradeable`) and token rescue mechanisms.

---

## 🏗 Directory Architecture

```
dex-fee-vault/
├── contracts/
│   ├── DexFeeVaultUpgradeable.sol       # Core UUPS Upgradeable DEX Fee Vault Contract
│   ├── interfaces/
│   │   ├── IDexFeeVault.sol              # Clean Interface & Custom Errors
│   │   ├── INonfungiblePositionManager.sol # Uniswap V3 Fee Collector Interface
│   │   └── IUniswapV2Pair.sol            # Uniswap V2 Pair Interface
│   └── mock/
│       ├── MockERC20.sol                 # Mock ERC20 Token for Testing
│       ├── MockUniswapV3PositionManager.sol # Mock V3 Position Manager
│       ├── MockUniswapV2Pair.sol         # Mock V2 Pair
│       └── DexFeeVaultV2Mock.sol         # Mock Contract V2 for Testing Proxy Upgrades
├── scripts/
│   ├── deploy.js                         # UUPS Deployment Script
│   ├── upgrade.js                        # Proxy Upgrade Script
│   └── distribute.js                     # Fee Distribution Execution Utility
├── test/
│   └── DexFeeVault.test.js               # Comprehensive Hardhat Test Suite (100% Coverage)
├── hardhat.config.js                     # Hardhat Config with LitVM & Arbitrum Networks
├── package.json                          # Package Specs & Scripts
└── .env.example                          # Environment Variables Blueprint
```

---

## 🚀 Quick Start & Installation

### 1. Install Dependencies
```bash
npm install
```

### 2. Compile Smart Contracts
```bash
npm run compile
```

### 3. Run Test Suite
```bash
npm run test
```

---

## ⚡ Deployment & Upgrading

### Configure Environment
Copy `.env.example` to `.env` and fill in your private key and RPC endpoints:
```env
PRIVATE_KEY=0x...
LITVM_RPC_URL=https://liteforge.rpc.caldera.xyz/infra-partner-http
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
```

### Deploying UUPS Proxy to LitVM Testnet/Mainnet
```bash
npm run deploy:litvm
```

### Upgrading Implementation (UUPS)
To upgrade the smart contract implementation while preserving all proxy state, beneficiary shares, and vault funds:
```bash
PROXY_ADDRESS=0xYourProxyAddress npm run upgrade:litvm
```

---

## 📊 Fee Flow & Allocations Diagram

```
 [Uniswap V2 Pairs] ──( skim )──────┐
                                    │
 [Uniswap V3 NFTs]  ──( collect )───┼──> [ DexFeeVault Proxy ] ──> (BPS Allocator)
                                    │
 [Swap Aggregators] ──( deposit )───┘                                    │
                                                                         ├──> 40% Partners
                                                                         ├──> 35% Core Team
                                                                         └──> 25% Treasury
```

---

## 🔐 Security & Audit Considerations
- All upgrade logic requires `UPGRADER_ROLE` authorization via `_authorizeUpgrade`.
- Beneficiary totals are strictly capped and validated against $10,000\text{ BPS}$.
- Push mode automatically falls back to claimable pending balances if a beneficiary contract/wallet fails to receive native ETH.
# litvmswap-fee-vault-smart-contract
