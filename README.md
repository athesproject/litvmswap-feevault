# litvmswap-feevault

The LitVMSwap fee vault and the aggregator entrypoint, both UUPS-upgradeable (ERC-1967) and live on LitVM.

| Contract | Version | Proxy (LitVM 4441) |
|---|---|---|
| `contracts/DexFeeVaultUpgradeable.sol` | 2.9.0 | `0xF2DF37067a8Af0e9ae617c96C887B2FdA8eA3f10` |
| `contracts/entrypoint/AggregatorEntrypoint.sol` | 2.0.0 | `0x5E19EB2A6BA30892CCe33f93D7Fb24D498512266` |

Implementations and their status: [DEPLOYMENTS.md](DEPLOYMENTS.md).

## Fee vault

Collects the protocol's revenue and splits it between beneficiaries.

- **Sources.** V2: the V2 factory's `feeTo` is the vault, and `redeemV2LpTokens` turns the protocol's LP into the
  two tokens. V3: the vault owns the V3 factory, `collectV3ProtocolFees` collects the protocol fee of the pools it
  is given and `enableProtocolFee` switches it on for pools still at zero. Positions the vault owns:
  `collectV3Positions`. Aggregator: the entrypoint sends its protocol fee straight to the vault.
- **Split.** Beneficiaries have shares in basis points that always add up to exactly 100%: `replaceBeneficiaries`
  sets the whole split in one call, and `setBeneficiary` (a wallet change) refuses to leave it anywhere else.
  `distributeRegistered` splits zkLTC and every registered token, pushing to the wallets or recording what each is
  owed; anyone can then `claimFor` a beneficiary, which pays that beneficiary only.
- **Accounting.** Deposits record what actually arrived; distribution counters count what was credited, and the
  rounding remainder (reported by `DistributionRemainder`) stays for the next split. The vault always holds at least
  what it owes.
- **Administration.** On LitVM `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` belong to the 48-hour timelock
  `0x35774e0172571314fcDa7d602ea4D3410EE37188` (since 2026-10-25; the 2-of-3 Safe
  `0x868b8B48db5DDE602D24960A606A5A8F93333bf9` proposes and executes, a guardian can cancel). `FEE_MANAGER_ROLE` and
  `PAUSER_ROLE` stay with the Safe, so a pause is immediate. The entrypoint is owned by the same timelock.

## Aggregator entrypoint

Takes the user's tokens, charges the fees, runs the route on the aggregator router
([athesproject/aggregator](https://github.com/athesproject/aggregator)) and delivers the output.

- **Fee policy.** The protocol fee must go to the vault and lie between `minFeeBps` (5 = 0.05%) and `maxFeeBps`
  (100 = 1%). An integrator (referrer) fee is optional, chosen by the integrator and capped at
  `maxReferrerFeeBps` (500 = 5%).
- **Measured amounts.** Fees and the swap use the input that actually arrived, the output is what the router
  actually delivered, and the minimum is checked against what the receiver actually got.
- **Nothing stays.** A swap whose input is not fully spent reverts; native is accepted only from the router.

Supported tokens: standard ERC-20 tokens. Fee-on-transfer tokens are measured correctly but only V2 pairs accept
them; rebasing tokens are not supported. Only standard tokens are registered for distribution.

## Build and test

```shell
npm ci                    # .npmrc: official registry, exact versions, no install scripts
npx hardhat compile
npx hardhat test
npx hardhat run scripts/validate-upgrade.js --network litvm   # read-only upgrade-safety gate
```

Compiler: solc 0.8.24, optimizer 1 run (the vault sits close to the 24,576-byte limit; `test/ContractSize.test.js`
checks it), via-IR, EVM cancun.

`scripts/validate-upgrade.js` proves that the reference contracts in `contracts/legacy/` are byte for byte the
implementations running on LitVM (apart from the metadata hash and the implementation's own address), then checks
that the new implementations are storage-compatible upgrades of them.

## Deployments and upgrades

On LitVM nothing is deployed or administered from a private key: deployments and upgrades are Safe transactions
(CreateCall for new code), proposed and checked in the Safe console. The scripts in `scripts/` are the original
setup tools; their `PRIVATE_KEY` variable is for local networks and forks only.

## Dependencies

Exact versions, the official npm registry and no install scripts (`.npmrc`); the lockfile's packages were checked
against npmjs (identical integrity hashes) on 2026-10-24. CI enforces this on every push: `.github/policy.py` fails on
an action, submodule or dependency that is not pinned, another registry, a lockfile entry without an integrity hash,
install scripts or a workflow that can write.

Known advisories without an applicable fix, all in development tooling and none in the contracts:

| Package (path) | Severity | Why it stays | Review by |
|---|---|---|---|
| `lodash` 4.17.23 (`@nomicfoundation/ignition-core`) | high | no fixed 4.17 release; Ignition only reads this repository's own modules | 2026-12-31 (Hardhat 3 migration) |
| `serialize-javascript` 7.1.2 (mocha) | high | the fix (7.1.3) was published on 2026-10-22; taken once it is 7 days old | 2026-10-29 |

## Provenance

The fee vault is LitVMSwap's own code (MIT). Entrypoint 1.0.0 was partly derived from Kuru's Flow entrypoint
(BUSL-1.1, Fastlane Labs); 2.0.0 is new code (MIT) with the same storage layout and interface. The 1.0.0 and 2.8.0
sources stay in `contracts/legacy/` as upgrade references, with their original license headers.

## Security

See [SECURITY.md](SECURITY.md).
