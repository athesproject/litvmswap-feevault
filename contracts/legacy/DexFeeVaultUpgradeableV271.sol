// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../utils/ReentrancyGuardUpgradeable.sol";
import "../interfaces/IDexFeeVault.sol";
import "../interfaces/INonfungiblePositionManager.sol";
import "../interfaces/IUniswapV2Pair.sol";
import "../interfaces/IUniswapV2Factory.sol";
import "../interfaces/IUniswapV3Pool.sol";

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
 */
/// @dev The deployed v2.7.1 implementation, kept only so tests can upgrade from it (storage layout and state).
contract DexFeeVaultUpgradeableV271 is
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
    uint256[16] private __gap_v26;

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

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address admin,
        BeneficiaryInput[] memory initialBeneficiaries,
        bool allowPublicDistribution
    ) external initializer {
        if (admin == address(0)) revert InvalidAddress();
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
    }

    receive() external payable {
        // Native arriving mid-harvest is V2/V3 revenue and is attributed by the
        // harvest routines themselves — crediting it here too would double count.
        if (!_inHarvest) cumulativeAggregatorFeesETH += msg.value;
        emit FeeReceived(msg.sender, msg.value);
    }
    fallback() external payable {
        if (msg.value > 0) {
            if (!_inHarvest) cumulativeAggregatorFeesETH += msg.value;
            emit FeeReceived(msg.sender, msg.value);
        }
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

    /// @notice Returns all V3 tokenIds currently owned by this vault for a given manager.
    ///         Useful for the frontend to display owned positions without any manual tracking.
    function getOwnedV3Positions(address positionManager)
        external view returns (uint256[] memory tokenIds)
    {
        IERC721EnumerableV271 nft = IERC721EnumerableV271(positionManager);
        uint256 count = nft.balanceOf(address(this));
        tokenIds = new uint256[](count);
        for (uint256 i = 0; i < count; i++) {
            tokenIds[i] = nft.tokenOfOwnerByIndex(address(this), i);
        }
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
    function _getWrappedNative() internal view returns (address) {
        address w = wrappedNativeToken;
        if (w == address(0)) {
            w = 0x315374AA9b5536037Cc1Efeea2439CCC0913A77e; // default wzkLTC on LitVM
        }
        return w;
    }

    function _harvestV2() internal returns (uint256 v2Count) {
        v2Count = registeredV2Pairs.length;
        address wNative = _getWrappedNative();
        (uint256 e0, uint256 w0) = _snapshot(wNative);

        for (uint256 i = 0; i < v2Count; i++) {
            address pair = registeredV2Pairs[i];
            // 1. Redeem protocol-fee LP minted to this vault by factory.feeTo.
            //    This is where V2 revenue actually lives; skim() returns nothing
            //    on a synced pair and was the reason V2 earnings sat stranded.
            _redeemOneV2Pair(pair);
            // 2. Sweep any genuinely unsynced surplus sitting on the pair.
            try IUniswapV2Pair(pair).skim(address(this)) {} catch { emit V2SkimFailed(pair); }
        }

        cumulativeV2FeesETH += _gain(wNative, e0, w0);
    }

    function _harvestV3Positions() internal returns (uint256 totalPositions) {
        address wNative = _getWrappedNative();
        uint256 mgCount = registeredV3Managers.length;
        (uint256 e0, uint256 w0) = _snapshot(wNative);
        uint128 MAX128 = type(uint128).max;

        for (uint256 m = 0; m < mgCount; m++) {
            IERC721EnumerableV271 nft = IERC721EnumerableV271(registeredV3Managers[m]);
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

    function _harvestV3Pools() internal returns (uint256 totalPoolsCollected) {
        address wNative = _getWrappedNative();
        (uint256 e0, uint256 w0) = _snapshot(wNative);
        uint256 poolCount = registeredV3Pools.length;
        uint128 MAX128 = type(uint128).max;

        for (uint256 i = 0; i < poolCount; i++) {
            try IUniswapV3Pool(registeredV3Pools[i]).collectProtocol(
                address(this), MAX128, MAX128
            ) returns (uint128 a0, uint128 a1) {
                if (a0 > 0 || a1 > 0) {
                    totalPoolsCollected++;
                    emit V3ProtocolFeesCollected(registeredV3Pools[i], a0, a1);
                }
            } catch { emit V3ProtocolCollectFailed(registeredV3Pools[i]); }
        }

        cumulativeV3FeesETH += _gain(wNative, e0, w0);
    }

    function harvest() public whenNotPaused nonReentrant {
        _inHarvest = true;
        uint256 v2Count = _harvestV2();
        uint256 totalV3Positions = _harvestV3Positions();
        uint256 totalV3PoolsCollected = _harvestV3Pools();
        _inHarvest = false;

        emit HarvestCompleted(v2Count, totalV3Positions, totalV3PoolsCollected);
    }

    /**
     * @notice Harvest all sources AND distribute — the single call the keeper makes.
     */
    function harvestAndDistribute(bool autoPush) external whenNotPaused {
        harvest();
        _distributeAll(autoPush);
    }

    function distributeRegistered(bool autoPush) external whenNotPaused canDistribute {
        _distributeAll(autoPush);
    }

    function _distributeAll(bool autoPush) internal {
        if (totalBps != MAX_BPS) return;
        if (address(this).balance > totalReservedETHFees) _distributeETHInternal(autoPush);
        uint256 n = registeredDistributionTokens.length;
        for (uint256 i = 0; i < n; i++) {
            address t = registeredDistributionTokens[i];
            if (IERC20(t).balanceOf(address(this)) > totalReservedTokenFees[t]) {
                _distributeTokenInternal(t, autoPush);
            }
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

    function depositFee(address token, uint256 amount) external whenNotPaused nonReentrant {
        if (token == address(0)) revert InvalidAddress();
        if (amount == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit FeeDeposited(token, msg.sender, amount);
    }

    function depositAggregatorFee(
        address token, uint256 amount, bytes calldata metadata
    ) external payable whenNotPaused nonReentrant {
        (metadata);
        if (token == address(0)) {
            if (msg.value != amount) revert ZeroAmount();
            cumulativeAggregatorFeesETH += msg.value;
            emit FeeReceived(msg.sender, msg.value);
        } else {
            if (amount == 0) revert ZeroAmount();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            emit FeeDeposited(token, msg.sender, amount);
        }
    }

    // Manual one-off collect (for positions not owned by vault, e.g. approved)
    function collectUniswapV3Fees(
        address positionManager, uint256 tokenId, uint128 amount0Max, uint128 amount1Max
    ) external whenNotPaused nonReentrant returns (uint256 amount0, uint256 amount1) {
        if (positionManager == address(0)) revert InvalidAddress();
        (amount0, amount1) = INonfungiblePositionManager(positionManager).collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId, recipient: address(this),
                amount0Max: amount0Max, amount1Max: amount1Max
            })
        );
        emit UniswapV3FeeCollected(positionManager, tokenId, address(this), amount0, amount1);
    }

    function collectUniswapV2Fees(address pair)
        external whenNotPaused nonReentrant returns (uint256 amount0, uint256 amount1)
    {
        if (pair == address(0)) revert InvalidAddress();
        IUniswapV2Pair v2 = IUniswapV2Pair(pair);
        address t0 = v2.token0(); address t1 = v2.token1();
        uint256 b0 = IERC20(t0).balanceOf(address(this));
        uint256 b1 = IERC20(t1).balanceOf(address(this));

        // Pre-v2.6 this only skimmed, which returns nothing on a synced pair.
        // The value is in the fee LP, so redeem that first.
        _inHarvest = true;
        _redeemOneV2Pair(pair);
        try v2.skim(address(this)) {} catch { emit V2SkimFailed(pair); }
        _inHarvest = false;

        amount0 = IERC20(t0).balanceOf(address(this)) - b0;
        amount1 = IERC20(t1).balanceOf(address(this)) - b1;
        emit UniswapV2FeeCollected(pair, t0, t1, amount0, amount1);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Beneficiary Management
    // ──────────────────────────────────────────────────────────────────────

    function setBeneficiary(bytes32 id, address wallet, uint16 bps, string calldata name)
        external onlyRole(FEE_MANAGER_ROLE)
    { _setBeneficiary(id, wallet, bps, name); }

    function _setBeneficiary(bytes32 id, address wallet, uint16 bps, string memory name) internal {
        if (id == bytes32(0)) revert InvalidBeneficiary();
        if (wallet == address(0)) revert InvalidAddress();
        Beneficiary storage b = beneficiaries[id];
        uint16 cur = b.isActive ? b.bps : 0;
        uint16 next = totalBps - cur + bps;
        if (next > MAX_BPS) revert InvalidBpsTotal(next, MAX_BPS);
        if (!b.isActive) { b.id = id; b.isActive = true; beneficiaryIds.push(id); }
        b.wallet = wallet; b.bps = bps; b.name = name;
        totalBps = next;
        emit BeneficiaryUpdated(id, wallet, bps, name);
    }

    function removeBeneficiary(bytes32 id) external onlyRole(FEE_MANAGER_ROLE) {
        Beneficiary storage b = beneficiaries[id];
        if (!b.isActive) revert BeneficiaryNotFound(id);
        totalBps -= b.bps;
        b.isActive = false; b.bps = 0;
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            if (beneficiaryIds[i] == id) {
                beneficiaryIds[i] = beneficiaryIds[len - 1];
                beneficiaryIds.pop(); break;
            }
        }
        emit BeneficiaryRemoved(id);
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
        cumulativeDistributedETH += dist;
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary storage b = beneficiaries[beneficiaryIds[i]];
            if (!b.isActive || b.bps == 0) continue;
            uint256 share = (dist * b.bps) / MAX_BPS;
            if (share == 0) continue;
            bool pushed;
            if (autoPush) (pushed,) = payable(b.wallet).call{value: share}("");
            if (!pushed) { pendingETH[b.wallet] += share; totalReservedETHFees += share; }
        }
        emit FeesDistributed(address(0), dist, autoPush);
    }

    function distributeToken(address token, bool autoPush) public whenNotPaused nonReentrant canDistribute {
        if (token == address(0)) revert InvalidAddress();
        if (totalBps != MAX_BPS) revert InvalidBpsTotal(totalBps, MAX_BPS);
        _distributeTokenInternal(token, autoPush);
    }

    function _distributeTokenInternal(address token, bool autoPush) internal {
        uint256 dist = IERC20(token).balanceOf(address(this)) - totalReservedTokenFees[token];
        if (dist == 0) revert NoFeesToDistribute();
        uint256 len = beneficiaryIds.length;
        for (uint256 i = 0; i < len; i++) {
            Beneficiary storage b = beneficiaries[beneficiaryIds[i]];
            if (!b.isActive || b.bps == 0) continue;
            uint256 share = (dist * b.bps) / MAX_BPS;
            if (share == 0) continue;
            if (autoPush) { IERC20(token).safeTransfer(b.wallet, share); }
            else { pendingTokens[token][b.wallet] += share; totalReservedTokenFees[token] += share; }
        }
        emit FeesDistributed(token, dist, autoPush);
    }

    function distributeBatch(address[] calldata tokens, bool includeETH, bool autoPush) external whenNotPaused {
        if (includeETH) distributeETH(autoPush);
        for (uint256 i = 0; i < tokens.length; i++) distributeToken(tokens[i], autoPush);
    }

    // ──────────────────────────────────────────────────────────────────────
    // Claim
    // ──────────────────────────────────────────────────────────────────────

    /// @dev Shared by claimETH and claimAll so the accounting can never drift.
    ///      Pre-v2.6 claimAll skipped cumulativeClaimedETH, understating the total.
    function _claimETHTo(address who) internal returns (uint256 amt) {
        amt = pendingETH[who];
        if (amt == 0) return 0;
        pendingETH[who] = 0;
        totalReservedETHFees -= amt;
        cumulativeClaimedETH += amt;
        (bool ok,) = payable(who).call{value: amt}("");
        if (!ok) revert TransferFailed();
        emit FeesClaimed(who, address(0), amt);
    }

    function _claimTokenTo(address token, address who) internal returns (uint256 amt) {
        amt = pendingTokens[token][who];
        if (amt == 0) return 0;
        pendingTokens[token][who] = 0;
        totalReservedTokenFees[token] -= amt;
        IERC20(token).safeTransfer(who, amt);
        emit FeesClaimed(who, token, amt);
    }

    function claimETH() external nonReentrant whenNotPaused {
        if (_claimETHTo(msg.sender) == 0) revert NoFeesToDistribute();
    }

    function claimToken(address token) external nonReentrant whenNotPaused {
        if (token == address(0)) revert InvalidAddress();
        if (_claimTokenTo(token, msg.sender) == 0) revert NoFeesToDistribute();
    }

    function claimAll(address[] calldata tokens, bool includeETH) external nonReentrant whenNotPaused {
        if (includeETH) _claimETHTo(msg.sender);
        for (uint256 i = 0; i < tokens.length; i++) {
            _claimTokenTo(tokens[i], msg.sender);
        }
    }

    // ──────────────────────────────────────────────────────────────────────
    // Views
    // ──────────────────────────────────────────────────────────────────────

    function getBeneficiary(bytes32 id) external view returns (Beneficiary memory) { return beneficiaries[id]; }
    function getAllBeneficiaryIds() external view returns (bytes32[] memory) { return beneficiaryIds; }
    function getTotalBps() external view returns (uint16) { return totalBps; }
    struct StreamStats {
        uint256 aggregatorFeesETH;
        uint256 v2FeesETH;
        uint256 v3FeesETH;
        uint256 v3PositionFeesETH;
        uint256 totalDistributedETH;
        uint256 totalClaimedETH;
        uint256 vaultETHBalance;
        uint256 totalReservedETH;
        uint256 v2PoolsCount;
        uint256 v3PoolsCount;
    }

    function getStreamStats() external view returns (StreamStats memory) {
        return StreamStats({
            aggregatorFeesETH: cumulativeAggregatorFeesETH,
            v2FeesETH: cumulativeV2FeesETH,
            v3FeesETH: cumulativeV3FeesETH,
            v3PositionFeesETH: cumulativeV3PositionFeesETH,
            totalDistributedETH: cumulativeDistributedETH,
            totalClaimedETH: cumulativeClaimedETH,
            vaultETHBalance: address(this).balance,
            totalReservedETH: totalReservedETHFees,
            v2PoolsCount: registeredV2Pairs.length,
            v3PoolsCount: registeredV3Pools.length
        });
    }

    function version() external pure virtual returns (string memory) { return "2.7.1"; }

    function setWrappedNativeToken(address _token) external onlyRole(DEFAULT_ADMIN_ROLE) {
        wrappedNativeToken = _token;
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
        if (token == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else { IERC20(token).safeTransfer(to, amount); }
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
        require(target != address(0), "bad target");
        bool ok;
        (ok, result) = target.call(data);
        require(ok, "factoryCall failed");
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

    function _removeFromArray(address[] storage arr, address val) internal {
        uint256 len = arr.length;
        for (uint256 i = 0; i < len; i++) {
            if (arr[i] == val) { arr[i] = arr[len - 1]; arr.pop(); return; }
        }
    }
}

/// @dev Minimal ERC-721 Enumerable interface — used to auto-discover V3 positions
interface IERC721EnumerableV271 {
    function balanceOf(address owner) external view returns (uint256);
    function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256);
}
