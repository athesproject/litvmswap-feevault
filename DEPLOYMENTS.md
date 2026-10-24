# Deployments

## LitVM LiteForge (chain 4441, testnet)

| Contract | Address | Status |
|---|---|---|
| Fee vault proxy | `0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10` | live |
| Fee vault implementation 2.9.0 | `0x2a6b31c57Dd1dB3CD1E76e80A32B45e0793Ad8cf` | pending: Safe transaction at nonce 6 |
| Fee vault implementation 2.8.0 | `0x76d51f012850B14f4AD713213cE0D92c1C4203C6` | live until then (source: `contracts/legacy/DexFeeVaultUpgradeableV28.sol`) |
| Entrypoint proxy | `0x5E19EB2A6BA30892CCe33f93D7Fb24D498512266` | live |
| Entrypoint implementation 2.0.0 | `0x584CFC4cedee87F458c570A229C6633Afea86C2A` | pending: Safe transaction at nonce 6 |
| Entrypoint implementation 1.0.0 | `0xdB23c1d071C274872f5Ba97F66d0182475b617c2` | live until then (source: `contracts/legacy/AGGFlowEntrypointUpgradeable.sol`) |

The 2.9.0 and 2.0.0 implementations are deployed by the Safe with CreateCall `performCreate2` (deployer = the Safe):

| Implementation | CREATE2 salt | Init code hash |
|---|---|---|
| DexFeeVaultUpgradeable 2.9.0 | `keccak256("litvm-fee-vault-v2.9.0-impl")` | `0xaa61faa6388033ef2337287650c8944c9cb8fae51a578de5b6730ccc1c7b7940` |
| AggregatorEntrypoint 2.0.0 | `keccak256("litvm-entrypoint-v2.0.0-impl")` | `0xfbbc0ff2a17220070be91908dbff1a88a5226fd73d7cdfccf996117354e0813a` |

The same Safe transaction calls `initializeV2(100, 500)` on the entrypoint (fee caps 1% protocol, 5% integrator) and
points it at the aggregator router 2.0.0 `0x9A3158beBDEFd2C9DD9D00e6B14F66E1c5E7d514`. `test/BuildReproducibility.test.js`
pins both init code hashes.

Compiler: solc 0.8.24, optimizer 1 run, via-IR, EVM cancun, OpenZeppelin Contracts (upgradeable) 5.6.1.
