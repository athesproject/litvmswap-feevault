// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IDexFeeVault.sol";
import "./interfaces/INonfungiblePositionManager.sol";
import "./interfaces/IUniswapV2Pair.sol";
import "./interfaces/IUniswapV2Factory.sol";
import "./interfaces/IUniswapV3Pool.sol";
import "./interfaces/IUniswapV3Factory.sol";

/**
 * @title DexFeeVaultUpgradeable  v2.2
 *
 * V3 PROTOCOL FEES — FULLY ON-CHAIN, ZERO EXTERNAL SCRIPTS:
 * The vault holds the V3 factory owner role. Admin registers pool addresses
 * once. harvest() automatically calls pool.collectProtocol(vault, max, max)
 * on every registered pool — no block scanning, no keeper scripts for V3.
 * setV3PoolFeeProtocol() lets admin enable/update feeProtocol on any pool.
 *
 * V3 LP positions: vault auto-discovers owned NFT positions via ERC-721
 * enumeration — no tokenId registration needed.
 *
 * V2 pairs: registration is now self-healing — syncV2Pairs() pulls every pair
 * the factory has created into the registry, cursor-paged so it cannot run out
 * of gas. V2 PROTOCOL FEES ARE LP TOKENS: factory.feeTo mints pair LP to this
 * vault on mint()/burn(), and skim() does NOT return them. harvest() now
 * redeems that LP via transfer+burn so V2 revenue becomes spendable.
 *
 * Distribution tokens: one-time registration per token (WETH, USDC, etc.)
 *
 * v2.8 (audit, plan/fee-vault-audit-and-redesign.md): every harvest and distribution
 * entry point is nonReentrant and follows the same distribution rule; a token that
 * fails is skipped instead of stopping the run, and a failed push stays owed;
 * emergencyWithdraw cannot touch owed funds; factoryCall only reaches the V3 factory;
 * calls to unknown functions without value revert. New: claimFor (anyone pays a
 * beneficiary what it is owed, to that beneficiary only), movePending (admin moves
 * owed balances off a compromised wallet) and enableProtocolFee (anyone switches on
 * the protocol fee for real pools of the V3 factory, at the default the admin set).
 *
 * v2.9 (LitVM team audit, plan/litvm-team-audit-triage.md): deposits record what actually
 * arrived (ATH-08); no hard-coded wrapped-native fallback, the address must be a contract
 * (ATH-14); distribution counters count what was credited and report the rounding
 * remainder, which stays for the next run (ATH-14); distributeRegistered reverts on a split
 * that is not 100% and replaceBeneficiaries sets the whole split at once (ATH-18).
 * No storage changes.
 */
contract DexFeeVaultUpgradeable is
    Initializable,
    AccessControlUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    IDexFeeVault
{
    using SafeERC20 for IERC20;

    // ── Roles ──────────────────────────────────────────────────────────────
    bytes32 public constant FEE_MANAGER_ROLE = keccak256("FEE_MANAGER_ROLE");
    bytes32 public constant UPGRADER_ROLE    = keccak256("UPGRADER_ROLE");
    bytes32 public constant PAUSER_ROLE      = keccak256("PAUSER_ROLE");
    bytes32 public constant BOT_ROLE         = keccak256("BOT_ROLE");

    uint16 public constant MAX_BPS = 10000;

    // ── Beneficiary State ──────────────────────────────────────────────────
    bytes32[] public beneficiaryIds;
    mapping(bytes32 => Beneficiary) public beneficiaries;
    uint16  public totalBps;
    bool    public publicDistributionAllowed;

    // ── Pull Claim Balances ────────────────────────────────────────────────
    mapping(address => mapping(address => uint256)) public pendingTokens;
    mapping(address => uint256)  public pendingETH;
    mapping(address => uint256)  public totalReservedTokenFees;
    uint256 public totalReservedETHFees;

    // ── Source Registry ────────────────────────────────────────────────────

    // V2: one entry per permanent pair contract (WETH/USDC pair is always the same address)
    address[] public registeredV2Pairs;
    mapping(address => bool) public isRegisteredV2Pair;

    // V3: one entry per positionManager contract (e.g. one per DEX).
    // The vault auto-discovers ALL positions it owns via ERC-721 enumeration.
    // No tokenId registration ever needed.
    address[] public registeredV3Managers;
    mapping(address => bool) public isRegisteredV3Manager;

    // Distribution tokens produced by V2/V3 harvests (WETH, USDC, etc.)
    address[] public registeredDistributionTokens;
    mapping(address => bool) public isRegisteredDistributionToken;

    // Storage gap — always last, always reduced by number of new slots added above
    uint256[32] private __gap;

    // v2.2: V3 pool registry for on-chain collectProtocol()
    // Appended AFTER __gap to satisfy UUPS storage layout rules.
    address[] public registeredV3Pools;
    mapping(address => bool) public isRegisteredV3Pool;

    // v2.4: Real-time cumulative stream tracking (in native wei)
    uint256 public cumulativeAggregatorFeesETH;
    uint256 public cumulativeV2FeesETH;
    uint256 public cumulativeV3FeesETH;
    uint256 public cumulativeV3PositionFeesETH;
    uint256 public cumulativeDistributedETH;
    uint256 public cumulativeClaimedETH;

    // v2.5: Wrapped native token configuration & multi-asset stream tracking
    address public wrappedNativeToken;

    // v2.6: registry self-sync + V2 LP redemption.
    // Appended at the very end — never reorder anything above this block.
    address public v2Factory;
    address public v3Factory;
    uint256 public v2SyncCursor;
    uint256 public cumulativeV2LpRedeemedETH;
    /// @dev Set only for the duration of harvest() so inbound native from a
    ///      harvest is not misattributed to the aggregator stream by receive().
    bool private _inHarvest;
    // v2.8: default protocol fee that anyone may apply to V3 pools still at zero, and the
    // pools the admin keeps at zero. The two uint8 pack into _inHarvest's slot; the mapping
    // takes one slot from the gap below, so nothing above moves.
    uint8 public defaultFeeProtocol0;
    uint8 public defaultFeeProtocol1;
    mapping(address => bool) public protocolFeeExempt;
    uint256[15] private __gap_v26;

    // ── Events ─────────────────────────────────────────────────────────────
    event V2PairRegistered(address indexed pair);
    event V2PairRemoved(address indexed pair);
    event V3ManagerRegistered(address indexed positionManager);
    event V3ManagerRemoved(address indexed positionManager);
    event V3PoolRegistered(address indexed pool);
    event V3PoolRemoved(address indexed pool);
    event V3ProtocolFeesCollected(address indexed pool, uint128 amount0, uint128 amount1);
    event DistributionTokenRegistered(address indexed token);
    event DistributionTokenRemoved(address indexed token);
    event HarvestCompleted(uint256 v2Count, uint256 v3PositionCount, uint256 v3PoolCount);
    // v2.6 — every previously-silent failure now surfaces as an event
    event V2LpRedeemed(address indexed pair, uint256 lpBurned, uint256 amount0, uint256 amount1);
    /// @dev reason: 1=zero supply, 2=dust (burn would revert), 3=burn reverted, 4=getReserves failed
    event V2LpRedeemSkipped(address indexed pair, uint256 lpHeld, uint8 reason);
    event V2SkimFailed(address indexed pair);
    event V3PositionCollectFailed(address indexed positionManager, uint256 indexed tokenId);
    event V3ProtocolCollectFailed(address indexed pool);
    event V3FeeProtocolSet(address indexed pool, uint8 feeProtocol0, uint8 feeProtocol1);
    event V3FeeProtocolSetFailed(address indexed pool);
    event RegistrySynced(uint256 v2PairsAdded, uint256 cursor, uint256 total);
    event FactoriesConfigured(address v2Factory, address v3Factory);
    // v2.8
    event DistributionSkipped(address indexed token);
    event ClaimSkipped(address indexed wallet, address indexed token, uint256 amount);
    event PendingMoved(address indexed from, address indexed to, address indexed token, uint256 amount);
    event DefaultFeeProtocolSet(uint8 feeProtocol0, uint8 feeProtocol1);
    event ProtocolFeeExemptSet(address indexed pool, bool exempt);
    event WrappedNativeTokenSet(address token);
    // v2.9
    /// @dev Rounding left over by a distribution; it stays unallocated and goes out with the next one.
    event DistributionRemainder(address indexed token, uint256 amount);

    error UnknownFunction();
    error AmountReserved();
    error NotV3Factory();
    error InvalidFeeProtocol();
    error ProtocolFeeDefaultUnset();
    error UnexpectedNativeValue();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @param wrappedNative_ The chain's wrapped native token (wzkLTC on LitVM); v2.9 requires it up front.
    function initialize(
        address admin,
        BeneficiaryInput[] memory initialBeneficiaries,
        bool allowPublicDistribution,
        address wrappedNative_
    ) external initializer {
        if (admin == address(0)) revert InvalidAddress();
        _setWrappedNativeToken(wrappedNative_);
        __AccessControl_init();
        __ReentrancyGuard_init();
        __Pausable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(FEE_MANAGER_ROLE,   admin);
        _grantRole(UPGRADER_ROLE,      admin);
        _grantRole(PAUSER_ROLE,        admin);
        _grantRole(BOT_ROLE,           admin);
        publicDistributionAllowed = allowPublicDistribution;
        for (uint256 i = 0; i < initialBeneficiaries.length; i++) {
            _setBeneficiary(
                initialBeneficiaries[i].id,
                initialBeneficiaries[i].wallet,
                initialBeneficiaries[i].bps,
                initialBeneficiaries[i].name
            );
        }
        // v2.9: a split is complete or not set at all (ATH-18).
        if (totalBps != 0 && totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
    }

    receive() external payable {
        // Native arriving mid-harvest is V2/V3 revenue and is attributed by the
        // harvest routines themselves — crediting it here too would double count.
        if (!_inHarvest) cumulativeAggregatorFeesETH += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }
    fallback() external payable {
        // A call to a function the vault does not have must not look like a success.
        if (msg.value == 0) revert UnknownFunction();
        if (!_inHarvest) cumulativeAggregatorFeesETH += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Registry Management
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Register a Uniswap V2 pair for auto-harvesting.
    ///         Pair addresses are permanent — register once, works forever.
    function addV2Pair(address pair) external onlyRole(FEE_MANAGER_ROLE) {
        if (_register(registeredV2Pairs, isRegisteredV2Pair, pair)) emit V2PairRegistered(pair);
    }

    function removeV2Pair(address pair) external onlyRole(FEE_MANAGER_ROLE) {
        _deregister(registeredV2Pairs, isRegisteredV2Pair, pair);
        emit V2PairRemoved(pair);
    }

    /// @notice Register a V3 NonfungiblePositionManager address.
    ///         ONE address per DEX covers ALL positions the vault holds — now and future.
    ///         The contract auto-discovers every tokenId owned by this vault each harvest.
    ///         No manual tokenId registration ever needed.
    function addV3Manager(address positionManager) external onlyRole(FEE_MANAGER_ROLE) {
        if (_register(registeredV3Managers, isRegisteredV3Manager, positionManager))
            emit V3ManagerRegistered(positionManager);
    }

    function removeV3Manager(address positionManager) external onlyRole(FEE_MANAGER_ROLE) {
        _deregister(registeredV3Managers, isRegisteredV3Manager, positionManager);
        emit V3ManagerRemoved(positionManager);
    }

    // ── V3 Pool Registry (for collectProtocol) ─────────────────────────────

    /// @notice Register a V3 pool address for automatic protocol fee collection.
    ///         The vault must be the V3 factory owner — set via factory.setOwner(vault).
    ///         Call once per pool; harvest() sweeps all registered pools every cycle.
    function addV3Pool(address pool) external onlyRole(FEE_MANAGER_ROLE) {
        if (_register(registeredV3Pools, isRegisteredV3Pool, pool)) emit V3PoolRegistered(pool);
    }

    function addV3PoolsBatch(address[] calldata pools) external onlyRole(FEE_MANAGER_ROLE) {
        for (uint256 i = 0; i < pools.length; i++) {
            if (pools[i] == address(0)) continue;
            if (_register(registeredV3Pools, isRegisteredV3Pool, pools[i])) emit V3PoolRegistered(pools[i]);
        }
    }

    function removeV3Pool(address pool) external onlyRole(FEE_MANAGER_ROLE) {
        _deregister(registeredV3Pools, isRegisteredV3Pool, pool);
        emit V3PoolRemoved(pool);
    }

    /// @notice Set feeProtocol on one or more V3 pools. Vault must be factory owner.
    ///         feeProtocol0/1: valid values are 0 (disabled) or 4–10.
    ///         4 = 1/4 = 25%, 6 = 1/6 ≈ 16.7%, 10 = 1/10 = 10% of swap fees → protocol.
    function setV3PoolFeeProtocol(
        address[] calldata pools,
        uint8 feeProtocol0,
        uint8 feeProtocol1
    ) external onlyRole(FEE_MANAGER_ROLE) returns (uint256 succeeded, uint256 failed) {
        for (uint256 i = 0; i < pools.length; i++) {
            try IUniswapV3Pool(pools[i]).setFeeProtocol(feeProtocol0, feeProtocol1) {
                succeeded++;
                emit V3FeeProtocolSet(pools[i], feeProtocol0, feeProtocol1);
            } catch {
                failed++;
                emit V3FeeProtocolSetFailed(pools[i]);
            }
        }
    }

    /// @notice The protocol fee anyone may apply to pools still at zero (0 or 4-10 each; 0/0 turns it off).
    function setDefaultFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external onlyRole(FEE_MANAGER_ROLE) {
        if (!_validFeeProtocol(feeProtocol0) || !_validFeeProtocol(feeProtocol1)) revert InvalidFeeProtocol();
        defaultFeeProtocol0 = feeProtocol0;
        defaultFeeProtocol1 = feeProtocol1;
        emit DefaultFeeProtocolSet(feeProtocol0, feeProtocol1);
    }

    /// @notice Keep a pool at zero protocol fee even when someone calls enableProtocolFee.
    function setProtocolFeeExempt(address pool, bool exempt) external onlyRole(FEE_MANAGER_ROLE) {
        protocolFeeExempt[pool] = exempt;
        emit ProtocolFeeExemptSet(pool, exempt);
    }

    /**
     * @notice Switch on the protocol fee, at the admin's default, for V3 pools that still
     *         have it at zero. Anyone can call it: it only touches pools the V3 factory
     *         created (checked with factory.getPool), never exempt pools and never a pool
     *         whose fee is already set, so it can only route revenue here under the
     *         admin's own policy. New pools then need no admin transaction.
     */
    function enableProtocolFee(address[] calldata pools)
        external whenNotPaused nonReentrant returns (uint256 enabled)
    {
        uint8 f0 = defaultFeeProtocol0;
        uint8 f1 = defaultFeeProtocol1;
        if (f0 == 0 && f1 == 0) revert ProtocolFeeDefaultUnset();
        address fac = v3Factory;
        if (fac == address(0)) revert InvalidAddress();
        for (uint256 i = 0; i < pools.length; i++) {
            address p = pools[i];
            if (protocolFeeExempt[p] || !_isFactoryPoolWithFeeOff(fac, p)) continue;
            try IUniswapV3Pool(p).setFeeProtocol(f0, f1) {
                enabled++;
                emit V3FeeProtocolSet(p, f0, f1);
            } catch { emit V3FeeProtocolSetFailed(p); }
        }
    }

    function _validFeeProtocol(uint8 f) internal pure returns (bool) {
        return f == 0 || (f >= 4 && f <= 10);
    }

    /// @dev Never reverts for an address that has code; each read has its own try because
    ///      catch only covers the call in the try head.
    function _isFactoryPoolWithFeeOff(address fac, address p) internal view returns (bool) {
        if (p.code.length == 0) return false;
        IUniswapV3Pool pool = IUniswapV3Pool(p);
        address t0;
        address t1;
        uint24 fee;
        try pool.token0() returns (address a) { t0 = a; } catch { return false; }
        try pool.token1() returns (address a) { t1 = a; } catch { return false; }
        try pool.fee() returns (uint24 f) { fee = f; } catch { return false; }
        try pool.slot0() returns (uint160, int24, uint16, uint16, uint16, uint8 fp, bool) {
            if (fp != 0) return false;
        } catch { return false; }
        try IUniswapV3Factory(fac).getPool(t0, t1, fee) returns (address q) { return q == p; } catch { return false; }
    }

    function getRegisteredV3Pools() external view returns (address[] memory) {
        return registeredV3Pools;
    }

    /// @notice Register an ERC-20 token to include in automatic distribution.
    function addDistributionToken(address token) external onlyRole(FEE_MANAGER_ROLE) {
        if (_register(registeredDistributionTokens, isRegisteredDistributionToken, token))
            emit DistributionTokenRegistered(token);
    }

    function removeDistributionToken(address token) external onlyRole(FEE_MANAGER_ROLE) {
        _deregister(registeredDistributionTokens, isRegisteredDistributionToken, token);
        emit DistributionTokenRemoved(token);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Views: Registry
    // ──────────────────────────────────────────────────────────────────────

    function getRegisteredV2Pairs() external view returns (address[] memory) {
        return registeredV2Pairs;
    }

    function getRegisteredV3Managers() external view returns (address[] memory) {
        return registeredV3Managers;
    }

    function getRegisteredDistributionTokens() external view returns (address[] memory) {
        return registeredDistributionTokens;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Harvest — zero manual tokenId management
    // ──────────────────────────────────────────────────────────────────────

    /**
     * @notice Harvest all registered V2 pairs + all V3 positions owned by this vault.
     *         V3 positions are auto-discovered via ERC-721 enumeration — no tokenId
     *         registration needed. Any new position received since last cycle is
     *         automatically included.
     */
    /// @dev v2.9: no chain-specific fallback. The address is set at initialization (or, on proxies set up
    ///      before v2.9, by setWrappedNativeToken) and must be a contract.
    function _getWrappedNative() internal view returns (address) {
        return wrappedNativeToken;
    }

    function _harvestV3Positions() internal returns (uint256 totalPositions) {
        address wNative = _getWrappedNative();
        uint256 mgCount = registeredV3Managers.length;
        (uint256 e0, uint256 w0) = _snapshot(wNative);
        uint128 MAX128 = type(uint128).max;

        for (uint256 m = 0; m < mgCount; m++) {
            IERC721Enumerable nft = IERC721Enumerable(registeredV3Managers[m]);
            INonfungiblePositionManager mgr = INonfungiblePositionManager(registeredV3Managers[m]);
            uint256 posCount = nft.balanceOf(address(this));
            totalPositions += posCount;
            for (uint256 p = 0; p < posCount; p++) {
                uint256 tokenId = nft.tokenOfOwnerByIndex(address(this), p);
                try mgr.collect(
                    INonfungiblePositionManager.CollectParams({
                        tokenId:    tokenId,
                        recipient:  address(this),
                        amount0Max: MAX128,
                        amount1Max: MAX128
                    })
                ) {} catch { emit V3PositionCollectFailed(registeredV3Managers[m], tokenId); }
            }
        }

        cumulativeV3PositionFeesETH += _gain(wNative, e0, w0);
    }

    // v2.8: harvest() and harvestAndDistribute() are gone. They looped over every
    // registered pair and pool (692 + 719, far beyond a block's gas). The selective
    // calls below collect only what holds value, then distributeRegistered splits it.

    function distributeRegistered(bool autoPush) external whenNotPaused nonReentrant canDistribute {
        _distributeAll(autoPush);
    }

    function _distributeAll(bool autoPush) internal {
        // v2.9: an incomplete split fails loudly, like every other distribution path (ATH-18).
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
        if (address(this).balance > totalReservedETHFees) _distributeETHInternal(autoPush);
        uint256 n = registeredDistributionTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address t = registeredDistributionTokens[i];
            // v2.8: a token that cannot report its balance no longer stops every other token.
            (bool ok, uint256 bal) = _tryBalanceOf(t);
            if (!ok) { emit DistributionSkipped(t); continue; }
            if (bal > totalReservedTokenFees[t]) _distributeTokenInternal(t, bal, autoPush);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // V2 protocol-fee redemption (LP tokens -> underlying)
    // ──────────────────────────────────────────────────────────────────────

    /**
     * @notice Redeem one pair's protocol-fee LP into its underlying tokens.
     * @dev    Callable only by the vault itself. It is a separate *external*
     *         function on purpose: pair.burn() must be preceded by transferring
     *         the LP into the pair, and if burn() then reverts the LP would be
     *         left sitting in the pair for anyone to claim. Routing through an
     *         external self-call means a revert rolls the transfer back atomically,
     *         while the caller's try/catch keeps one bad pair from failing harvest.
     */
    function redeemV2PairSelf(address pair) external returns (uint256 amount0, uint256 amount1) {
        if (msg.sender != address(this)) revert InvalidAddress();
        IUniswapV2Pair v2 = IUniswapV2Pair(pair);
        uint256 lp = v2.balanceOf(address(this));
        if (lp == 0) revert ZeroAmount();
        v2.transfer(pair, lp);
        (amount0, amount1) = v2.burn(address(this));
    }

    /// @dev Returns true when LP was actually redeemed. Never reverts.
    function _redeemOneV2Pair(address pair) internal returns (bool) {
        IUniswapV2Pair v2 = IUniswapV2Pair(pair);

        uint256 lp;
        try v2.balanceOf(address(this)) returns (uint256 b) { lp = b; } catch { return false; }
        if (lp == 0) return false;

        // Pre-flight the burn. UniswapV2 reverts with INSUFFICIENT_LIQUIDITY_BURNED
        // unless BOTH legs come out non-zero, and burn() mints a little extra LP to
        // feeTo (this vault) first, which nudges totalSupply up — so leave a margin
        // rather than testing for strictly greater than zero.
        // Each external read gets its own try. Solidity's catch only covers the
        // call in the try HEAD — anything in the success block propagates. With
        // getReserves() nested inside the totalSupply() block, one non-standard
        // pair holding LP would revert the entire harvest across every source.
        uint256 ts;
        try v2.totalSupply() returns (uint256 t) { ts = t; } catch { return false; }
        if (ts == 0) { emit V2LpRedeemSkipped(pair, lp, 1); return false; }

        uint112 r0;
        uint112 r1;
        try v2.getReserves() returns (uint112 a, uint112 b, uint32) { r0 = a; r1 = b; }
        catch { emit V2LpRedeemSkipped(pair, lp, 4); return false; }

        uint256 a0 = (lp * uint256(r0)) / ts;
        uint256 a1 = (lp * uint256(r1)) / ts;
        if (a0 <= 1 || a1 <= 1) { emit V2LpRedeemSkipped(pair, lp, 2); return false; }

        try this.redeemV2PairSelf(pair) returns (uint256 a0, uint256 a1) {
            emit V2LpRedeemed(pair, lp, a0, a1);
            return true;
        } catch {
            emit V2LpRedeemSkipped(pair, lp, 3);
            return false;
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Selective harvesting
    // ──────────────────────────────────────────────────────────────────────

    /**
     * @notice Collect protocol fees from specific V3 pools.
     * @dev    harvest() sweeps every registered pool — 471 of them — and costs
     *         ~31M gas per cycle even though only a handful ever hold fees at
     *         once. A caller can see exactly which pools have something with
     *         free off-chain reads (pool.protocolFees()), so let it say so and
     *         pay for that work only. Permissionless: it only moves value INTO
     *         this vault, and the keeper should not need a role to do it.
     */
    function collectV3ProtocolFees(address[] calldata pools)
        external whenNotPaused nonReentrant returns (uint256 collected)
    {
        address wNative = _getWrappedNative();
        (uint256 e0, uint256 w0) = _snapshot(wNative);
        uint128 MAX128 = type(uint128).max;

        _inHarvest = true;
        for (uint256 i = 0; i < pools.length; i++) {
            try IUniswapV3Pool(pools[i]).collectProtocol(address(this), MAX128, MAX128)
                returns (uint128 a0, uint128 a1)
            {
                if (a0 > 0 || a1 > 0) {
                    collected++;
                    emit V3ProtocolFeesCollected(pools[i], a0, a1);
                }
            } catch { emit V3ProtocolCollectFailed(pools[i]); }
        }
        _inHarvest = false;

        cumulativeV3FeesETH += _gain(wNative, e0, w0);
    }

    /**
     * @notice Collect fees from the V3 LP positions this vault owns.
     * @dev    Separated out so a keeper can harvest positions without also
     *         paying to sweep every registered pool and pair.
     */
    function collectV3Positions()
        external whenNotPaused nonReentrant returns (uint256 positions)
    {
        _inHarvest = true;
        positions = _harvestV3Positions();
        _inHarvest = false;
    }

    /**
     * @notice Redeem protocol-fee LP for an arbitrary list of pairs.
     * @dev    Works on ANY pair, registered or not — factory.feeTo mints LP for
     *         every pair the factory has ever created, so unregistered pairs
     *         accrue revenue too. Permissionless: it only ever moves value INTO
     *         this vault, and the keeper should be able to call it without a role.
     */
    function redeemV2LpTokens(address[] calldata pairs)
        external whenNotPaused nonReentrant returns (uint256 redeemed)
    {
        address wNative = _getWrappedNative();
        (uint256 e0, uint256 w0) = _snapshot(wNative);

        _inHarvest = true;
        for (uint256 i = 0; i < pairs.length; i++) {
            if (_redeemOneV2Pair(pairs[i])) redeemed++;
        }
        _inHarvest = false;

        uint256 gained = _gain(wNative, e0, w0);
        cumulativeV2FeesETH += gained;
        cumulativeV2LpRedeemedETH += gained;
    }

    // ──────────────────────────────────────────────────────────────────────
    // Registry self-sync
    // ──────────────────────────────────────────────────────────────────────

    function setFactories(address _v2Factory, address _v3Factory)
        external onlyRole(FEE_MANAGER_ROLE)
    {
        v2Factory = _v2Factory;
        v3Factory = _v3Factory;
        emit FactoriesConfigured(_v2Factory, _v3Factory);
    }

    /**
     * @notice Pull pairs the V2 factory has created into the registry.
     * @dev    Cursor-paged so it can never run out of gas no matter how many
     *         pairs exist; call repeatedly until `cursor == total`. Permissionless
     *         because registering a pair can only ever route more fees here.
     *         Reset the cursor with resetV2SyncCursor() if the registry is rebuilt.
     */
    function syncV2Pairs(uint256 limit) public whenNotPaused returns (uint256 added) {
        address fac = v2Factory;
        if (fac == address(0)) revert InvalidAddress();

        uint256 total = IUniswapV2Factory(fac).allPairsLength();
        uint256 i = v2SyncCursor;
        uint256 end = i + limit;
        if (end > total) end = total;

        for (; i < end; i++) {
            address pair = IUniswapV2Factory(fac).allPairs(i);
            if (pair != address(0) && !isRegisteredV2Pair[pair]) {
                registeredV2Pairs.push(pair);
                isRegisteredV2Pair[pair] = true;
                added++;
                emit V2PairRegistered(pair);
            }
        }
        v2SyncCursor = i;
        emit RegistrySynced(added, i, total);
    }

    function resetV2SyncCursor() external onlyRole(FEE_MANAGER_ROLE) { v2SyncCursor = 0; }

    // ──────────────────────────────────────────────────────────────────────
    // Manual fee deposit (aggregator / one-off)
    // ──────────────────────────────────────────────────────────────────────

    // v2.9: depositFee is gone; depositAggregatorFee(token, amount, "") does the same (smaller contract).
    function depositAggregatorFee(
        address token, uint256 amount, bytes calldata metadata
    ) external payable whenNotPaused nonReentrant {
        (metadata);
        if (token == address(0)) {
            if (msg.value != amount) revert ZeroAmount();
            cumulativeAggregatorFeesETH += msg.value;
            emit FeeReceived(msg.sender, msg.value);
        } else {
            if (msg.value != 0) revert UnexpectedNativeValue();
            if (amount == 0) revert ZeroAmount();
            emit FeeDeposited(token, msg.sender, _pullToken(token, amount));
        }
    }

    /// @dev v2.9: what actually arrived, so a token that takes a fee on transfer is recorded at its real
    ///      amount (ATH-08). Distribution already works from balances.
    function _pullToken(address token, uint256 amount) internal returns (uint256 received) {
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
    }

    // v2.8: collectUniswapV3Fees and collectUniswapV2Fees are gone; collectV3Positions
    // and redeemV2LpTokens do the same for every position and pair, permissionlessly.

    // ──────────────────────────────────────────────────────────────────────
    // Beneficiary Management
    // ──────────────────────────────────────────────────────────────────────

    /// @notice Change one beneficiary's wallet, share or name. v2.9: the split must still add up to exactly
    ///         100% afterwards, so this suits wallet changes; change the split with replaceBeneficiaries (ATH-18).
    function setBeneficiary(bytes32 id, address wallet, uint16 bps, string calldata name)
        external onlyRole(FEE_MANAGER_ROLE)
    {
        _setBeneficiary(id, wallet, bps, name);
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
    }

    function _setBeneficiary(bytes32 id, address wallet, uint16 bps, string memory name) internal {
        if (id == bytes32(0)) revert InvalidBeneficiary();
        if (wallet == address(0) || wallet == address(this)) revert InvalidAddress();
        Beneficiary storage b = beneficiaries[id];
        uint16 cur = b.isActive ? b.bps : 0;
        uint16 next = totalBps - cur + bps;
        if (next > MAX_BPS) revert InvalidBpsTotal(next, MAX_BPS);
        if (!b.isActive) { b.id = id; b.isActive = true; beneficiaryIds.push(id); }
        b.wallet = wallet; b.bps = bps; b.name = name;
        totalBps = next;
        emit BeneficiaryUpdated(id, wallet, bps, name);
    }

    /**
     * @notice v2.9: replace the whole split in one call; it must add up to exactly 100% (ATH-18). This also
     *         removes beneficiaries (leave them out); removeBeneficiary is gone because it always broke the
     *         split. Wallets keep what they are already owed.
     */
    function replaceBeneficiaries(BeneficiaryInput[] calldata list) external onlyRole(FEE_MANAGER_ROLE) {
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary storage b = beneficiaries[beneficiaryIds[i]];
            b.isActive = false; b.bps = 0;
            emit BeneficiaryRemoved(beneficiaryIds[i]);
        }
        delete beneficiaryIds;
        totalBps = 0;
        for (uint256 i = 0; i < list.length; i++) {
            _setBeneficiary(list[i].id, list[i].wallet, list[i].bps, list[i].name);
        }
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
    }

    function setPublicDistributionAllowed(bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        publicDistributionAllowed = allowed;
        emit PublicDistributionToggled(allowed);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Distribution
    // ──────────────────────────────────────────────────────────────────────

    modifier canDistribute() {
        if (!publicDistributionAllowed &&
            !hasRole(BOT_ROLE, msg.sender) &&
            !hasRole(FEE_MANAGER_ROLE, msg.sender) &&
            !hasRole(DEFAULT_ADMIN_ROLE, msg.sender))
        { revert DistributionNotAllowed(); }
        _;
    }

    function distributeETH(bool autoPush) public whenNotPaused nonReentrant canDistribute {
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
        _distributeETHInternal(autoPush);
    }

    function _distributeETHInternal(bool autoPush) internal {
        uint256 dist = address(this).balance - totalReservedETHFees;
        if (dist == 0) revert NoFeesToDistribute();
        uint256 credited;
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary storage b = beneficiaries[beneficiaryIds[i]];
            if (!b.isActive || b.bps == 0) continue;
            uint256 share = (dist * b.bps) / MAX_BPS;
            if (share == 0) continue;
            credited += share;
            bool pushed;
            if (autoPush) (pushed,) = payable(b.wallet).call{value: share}("");
            if (!pushed) { pendingETH[b.wallet] += share; totalReservedETHFees += share; }
        }
        // v2.9: count what was credited; the rounding remainder stays for the next run (ATH-14).
        cumulativeDistributedETH += credited;
        if (dist > credited) emit DistributionRemainder(address(0), dist - credited);
        emit FeesDistributed(address(0), credited, autoPush);
    }

    function distributeToken(address token, bool autoPush) public whenNotPaused nonReentrant canDistribute {
        if (token == address(0)) revert InvalidAddress();
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
        _distributeTokenInternal(token, IERC20(token).balanceOf(address(this)), autoPush);
    }

    function _distributeTokenInternal(address token, uint256 balance, bool autoPush) internal {
        uint256 dist = balance - totalReservedTokenFees[token];
        if (dist == 0) revert NoFeesToDistribute();
        uint256 credited;
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary storage b = beneficiaries[beneficiaryIds[i]];
            if (!b.isActive || b.bps == 0) continue;
            uint256 share = (dist * b.bps) / MAX_BPS;
            if (share == 0) continue;
            credited += share;
            // v2.8: a push that fails stays owed, as for ETH, instead of reverting the run.
            if (autoPush && _tryTransfer(token, b.wallet, share)) continue;
            pendingTokens[token][b.wallet] += share;
            totalReservedTokenFees[token] += share;
        }
        if (dist > credited) emit DistributionRemainder(token, dist - credited);
        emit FeesDistributed(token, credited, autoPush);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Claim
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Shared by every claim path so the accounting can never drift (pre-v2.6
    ///      claimAll skipped cumulativeClaimedETH). Strict: a failed payout reverts.
    ///      Soft (claimFor, v2.8): a failed payout stays owed and is reported.
    function _payOwed(address token, address who, bool soft) internal returns (uint256 amt) {
        bool native = token == address(0);
        amt = native ? pendingETH[who] : pendingTokens[token][who];
        if (amt == 0) return 0;
        if (native) { pendingETH[who] = 0; totalReservedETHFees -= amt; }
        else { pendingTokens[token][who] = 0; totalReservedTokenFees[token] -= amt; }
        bool ok;
        if (native) (ok,) = payable(who).call{value: amt}("");
        else ok = _tryTransfer(token, who, amt);
        if (ok) {
            if (native) cumulativeClaimedETH += amt;
            emit FeesClaimed(who, token, amt);
            return amt;
        }
        if (!soft) revert TransferFailed();
        if (native) { pendingETH[who] = amt; totalReservedETHFees += amt; }
        else { pendingTokens[token][who] = amt; totalReservedTokenFees[token] += amt; }
        emit ClaimSkipped(who, token, amt);
        return 0;
    }

    function claimETH() external nonReentrant whenNotPaused {
        if (_payOwed(address(0), msg.sender, false) == 0) revert NoFeesToDistribute();
    }

    function claimToken(address token) external nonReentrant whenNotPaused {
        if (token == address(0)) revert InvalidAddress();
        if (_payOwed(token, msg.sender, false) == 0) revert NoFeesToDistribute();
    }

    function claimAll(address[] calldata tokens, bool includeETH) external nonReentrant whenNotPaused {
        _payAll(msg.sender, tokens, includeETH, false);
    }

    /**
     * @notice Pay `wallet` what the vault owes it. Anyone can call this; the money can
     *         only go to `wallet`. A beneficiary that is a contract (the Safe) is paid
     *         without a transaction of its own. A payout that fails stays owed.
     */
    function claimFor(address wallet, address[] calldata tokens, bool includeETH) external nonReentrant whenNotPaused {
        if (wallet == address(0)) revert InvalidAddress();
        _payAll(wallet, tokens, includeETH, true);
    }

    function _payAll(address who, address[] calldata tokens, bool includeETH, bool soft) internal {
        if (includeETH) _payOwed(address(0), who, soft);
        for (uint256 i = 0; i < tokens.length; i++) {
            if (tokens[i] != address(0)) _payOwed(tokens[i], who, soft);
        }
    }

    /**
     * @notice Move what the vault owes `from` to `to`, for a beneficiary wallet that was
     *         compromised or replaced. The books stay exact: reserved totals do not change.
     */
    function movePending(address from, address to, address[] calldata tokens, bool includeETH)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0) || to == address(this) || to == from) revert InvalidAddress();
        if (includeETH) {
            uint256 a = pendingETH[from];
            if (a > 0) { pendingETH[from] = 0; pendingETH[to] += a; emit PendingMoved(from, to, address(0), a); }
        }
        for (uint256 i = 0; i < tokens.length; i++) {
            address t = tokens[i];
            uint256 a = pendingTokens[t][from];
            if (a > 0) { pendingTokens[t][from] = 0; pendingTokens[t][to] += a; emit PendingMoved(from, to, t, a); }
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────

    function getBeneficiary(bytes32 id) external view returns (Beneficiary memory) { return beneficiaries[id]; }
    function getAllBeneficiaryIds() external view returns (bytes32[] memory) { return beneficiaryIds; }

    function version() external pure virtual returns (string memory) { return "2.9.0"; }

    function setWrappedNativeToken(address _token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setWrappedNativeToken(_token);
    }

    function _setWrappedNativeToken(address _token) internal {
        if (_token.code.length == 0) revert InvalidAddress();
        wrappedNativeToken = _token;
        emit WrappedNativeTokenSet(_token);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Admin / Emergency
    // ──────────────────────────────────────────────────────────────────────

    function pause()   external onlyRole(PAUSER_ROLE) { _pause(); }
    function unpause() external onlyRole(PAUSER_ROLE) { _unpause(); }

    function emergencyWithdraw(address token, address to, uint256 amount)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        // v2.8: only what is not already owed to a beneficiary.
        if (token == address(0)) {
            if (amount > address(this).balance - totalReservedETHFees) revert AmountReserved();
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (amount > IERC20(token).balanceOf(address(this)) - totalReservedTokenFees[token]) revert AmountReserved();
            IERC20(token).safeTransfer(to, amount);
        }
        emit EmergencyWithdrawal(token, to, amount);
    }

    function _authorizeUpgrade(address newImpl) internal override onlyRole(UPGRADER_ROLE) {}

    // ──────────────────────────────────────────────────────────────────────
    // Factory Admin — vault is owner, so admin calls factory via vault
    // ──────────────────────────────────────────────────────────────────────

    /// @notice General-purpose proxy: lets admin call ANY function on any
    ///         contract from the vault (e.g. factory.enableFeeAmount, factory.setOwner).
    ///         Use when no specific wrapper exists below.
    ///         data = abi.encodeWithSignature("fnName(types)", args...)
    function factoryCall(
        address target,
        bytes calldata data
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (bytes memory result) {
        // v2.8: only the V3 factory. Anything else (a token transfer, for one) would
        // move value around the books.
        if (target == address(0) || target != v3Factory) revert NotV3Factory();
        bool ok;
        (ok, result) = target.call(data);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }

    // NOTE: transferV3FactoryOwner() and enableV3FeeAmount() were removed in v2.6 —
    // factoryCall(factory, abi.encodeWithSignature("setOwner(address)", addr)) and
    // factoryCall(factory, abi.encodeWithSignature("enableFeeAmount(uint24,int24)", f, t))
    // do exactly the same thing, and the implementation needs the bytecode room.

    // ──────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ──────────────────────────────────────────────────────────────────────

    function _register(address[] storage arr, mapping(address => bool) storage flag, address item)
        internal returns (bool)
    {
        if (item == address(0)) revert InvalidAddress();
        if (flag[item]) return false;
        arr.push(item);
        flag[item] = true;
        return true;
    }

    function _deregister(address[] storage arr, mapping(address => bool) storage flag, address item)
        internal
    {
        if (!flag[item]) revert InvalidAddress();
        flag[item] = false;
        _removeFromArray(arr, item);
    }

    /// @dev Native + wrapped-native balance snapshot, used to attribute a harvest
    ///      to the right revenue stream.
    /// @dev balanceOf on an address with no code returns empty data, which the
    ///      ABI decoder treats as a revert — that would take the whole harvest
    ///      down if wrappedNativeToken is unset and the fallback is wrong for the
    ///      chain. Accounting must never be able to block fee collection.
    function _wBal(address wNative) internal view returns (uint256) {
        // The code-length guard is load-bearing: Solidity emits an extcodesize
        // check before a high-level call that decodes a return value, and that
        // revert happens in OUR frame, so try/catch cannot catch it.
        if (wNative == address(0) || wNative.code.length == 0) return 0;
        try IERC20(wNative).balanceOf(address(this)) returns (uint256 b) { return b; }
        catch { return 0; }
    }

    function _snapshot(address wNative) internal view returns (uint256 e, uint256 w) {
        e = address(this).balance;
        w = _wBal(wNative);
    }

    function _gain(address wNative, uint256 e0, uint256 w0) internal view returns (uint256 g) {
        if (address(this).balance > e0) g = address(this).balance - e0;
        uint256 w1 = _wBal(wNative);
        if (w1 > w0) g += (w1 - w0);
    }

    /// @dev balanceOf that reports failure instead of reverting, so one token cannot stop a run.
    function _tryBalanceOf(address token) internal view returns (bool ok, uint256 bal) {
        if (token.code.length == 0) return (false, 0);
        (bool s, bytes memory r) = token.staticcall(abi.encodeWithSelector(IERC20.balanceOf.selector, address(this)));
        if (!s || r.length < 32) return (false, 0);
        return (true, abi.decode(r, (uint256)));
    }

    /// @dev transfer that reports failure instead of reverting (accepts tokens that return nothing).
    function _tryTransfer(address token, address to, uint256 amount) internal returns (bool) {
        if (token.code.length == 0) return false;
        (bool s, bytes memory r) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return s && (r.length == 0 || (r.length >= 32 && uint256(bytes32(r)) == 1));
    }

    function _removeFromArray(address[] storage arr, address val) internal {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == val) { arr[i] = arr[len - 1]; arr.pop(); return; }
        }
    }
}

/// @dev Minimal ERC-721 Enumerable interface — used to auto-discover V3 positions
interface IERC721Enumerable {
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}
