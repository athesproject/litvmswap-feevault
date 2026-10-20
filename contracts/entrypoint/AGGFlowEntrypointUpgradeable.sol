// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../utils/ReentrancyGuardUpgradeable.sol";
import "./AGGFlowEntrypointTypes.sol";

interface IAGGFlowRouter {
    function executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut,
        bytes memory program
    ) external payable returns (uint256 amountOut);
}

/**
 * @title AGGFlowEntrypointUpgradeable
 * @notice UUPS-upgradeable AGGFlow entrypoint with an ENFORCED protocol fee.
 *
 * Why this contract exists
 * ───────────────────────
 * In the original entrypoint, `feeCollectorAddress` and `feeBps` arrive in
 * calldata and are never checked. The 0.05% protocol fee was therefore a
 * convention the frontend chose to follow: anyone calling executeSwap directly
 * could point the fee at themselves, or set feeBps to 0, and pay the protocol
 * nothing. `requiredFeeCollector` and `minFeeBps` turn that convention into a
 * rule the contract enforces.
 *
 * Defaults are set in initialize(): the fee must go to the DexFeeVault, and it
 * must be at least 5 bps (0.05%).
 *
 * Upgradeability
 * ──────────────
 * UUPS with a real initializer, unlike the previous deployment which put a
 * constructor-based Ownable behind a proxy — so its storage layout never
 * matched its source and it could not be safely upgraded.
 */
contract AGGFlowEntrypointUpgradeable is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    address internal constant NATIVE_TOKEN = address(0);
    uint256 public  constant MAX_BPS       = 10_000;

    address private AGGFlowRouter;

    /// @notice Every swap must pay the protocol fee here. address(0) disables the check.
    address public requiredFeeCollector;
    /// @notice Minimum protocol fee in basis points. 0 disables the check.
    uint256 public minFeeBps;

    uint256[32] private __gap;

    event AGGFlowSwap(
        address indexed user,
        address indexed referrer,
        address tokenIn,
        address tokenOut,
        bool    isFeeInInput,
        uint256 amountIn,
        uint256 amountOut,
        uint256 referrerFeeBps,
        uint256 totalFeeBps
    );
    event FeeCollected(
        address feeCollector, uint256 amount,
        address referrer,     uint256 referrerAmount,
        address user,         address token
    );
    event RouterUpdated(address indexed oldRouter, address indexed newRouter);
    event FeePolicyUpdated(address indexed requiredFeeCollector, uint256 minFeeBps);

    error InvalidFeeStructure();
    error InvalidFeeCollector();
    error InvalidReferrer();
    error BuyAndSellTokensAreSame();
    error InsufficientNativeValue();
    error InsufficientAmountAfterFees();
    error InvalidRouter();
    error FeeCollectorNotAllowed();
    error FeeBelowMinimum();
    error NativeTransferFailed();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /**
     * @param owner_                Admin able to set the router, fee policy and upgrades
     * @param router_               AGGFlow router that executes the route
     * @param requiredFeeCollector_ DexFeeVault — the only address allowed to take the protocol fee
     * @param minFeeBps_            Minimum protocol fee, 5 = 0.05%
     */
    function initialize(
        address owner_,
        address router_,
        address requiredFeeCollector_,
        uint256 minFeeBps_
    ) external initializer {
        if (router_ == address(0)) revert InvalidRouter();
        if (minFeeBps_ > MAX_BPS) revert InvalidFeeStructure();

        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        // OZ 5.x UUPSUpgradeable carries no initializer — nothing to call here.

        AGGFlowRouter        = router_;
        requiredFeeCollector = requiredFeeCollector_;
        minFeeBps            = minFeeBps_;

        emit RouterUpdated(address(0), router_);
        emit FeePolicyUpdated(requiredFeeCollector_, minFeeBps_);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function getRouter() external view returns (address) { return AGGFlowRouter; }

    function setRouter(address newRouter) external onlyOwner {
        if (newRouter == address(0)) revert InvalidRouter();
        address old = AGGFlowRouter;
        AGGFlowRouter = newRouter;
        emit RouterUpdated(old, newRouter);
    }

    /**
     * @notice Change where the protocol fee must go and the floor it must meet.
     * @dev Setting a required collector with a zero minimum still lets a caller
     *      pass feeBps = 0 and pay nothing — set both together.
     */
    function setFeePolicy(address requiredFeeCollector_, uint256 minFeeBps_) external onlyOwner {
        if (minFeeBps_ > MAX_BPS) revert InvalidFeeStructure();
        requiredFeeCollector = requiredFeeCollector_;
        minFeeBps            = minFeeBps_;
        emit FeePolicyUpdated(requiredFeeCollector_, minFeeBps_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Swaps ───────────────────────────────────────────────────────────────

    function executeSwap(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program
    ) external payable nonReentrant returns (uint256 amountOut) {
        return _executeSwapInternal(swapIntent, feeCollection, program, msg.sender);
    }

    function executeSwapWithReceiver(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program,
        address receiver
    ) external payable nonReentrant returns (uint256 amountOut) {
        return _executeSwapInternal(swapIntent, feeCollection, program, receiver);
    }

    function _executeSwapInternal(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program,
        address receiver
    ) internal returns (uint256 amountOut) {
        if (swapIntent.tokenUserSells == swapIntent.tokenUserBuys) revert BuyAndSellTokensAreSame();

        _validateFeeStructure(feeCollection);
        _transferTokensFromUser(swapIntent);

        uint256 effectiveAmountIn = _handleFeeCollection(swapIntent, feeCollection);
        uint256 totalAmountOut = _executeAGGFlowSwap(
            swapIntent.tokenUserSells, effectiveAmountIn, swapIntent.tokenUserBuys, program
        );
        amountOut = _handleOutputAndTransfer(swapIntent, feeCollection, totalAmountOut, receiver);

        emit AGGFlowSwap(
            msg.sender,
            feeCollection.referrerAddress,
            swapIntent.tokenUserSells,
            swapIntent.tokenUserBuys,
            feeCollection.isInTokenFee,
            swapIntent.amountUserSells,
            amountOut,
            feeCollection.referrerFeeBps,
            feeCollection.feeBps + feeCollection.referrerFeeBps
        );
    }

    /// @dev The fee policy checks are the only thing standing between the
    ///      protocol and a swap that pays it nothing.
    function _validateFeeStructure(FeeCollection calldata feeCollection) internal view {
        if (feeCollection.feeBps + feeCollection.referrerFeeBps > MAX_BPS) revert InvalidFeeStructure();
        if (feeCollection.feeBps > 0 && feeCollection.feeCollectorAddress == address(0)) revert InvalidFeeCollector();
        if (feeCollection.referrerFeeBps > 0 && feeCollection.referrerAddress == address(0)) revert InvalidReferrer();

        address required = requiredFeeCollector;
        if (required != address(0) && feeCollection.feeCollectorAddress != required) revert FeeCollectorNotAllowed();
        if (feeCollection.feeBps < minFeeBps) revert FeeBelowMinimum();
    }

    function _transferTokensFromUser(SwapIntent calldata swapIntent) internal {
        if (swapIntent.tokenUserSells != NATIVE_TOKEN) {
            IERC20(swapIntent.tokenUserSells).safeTransferFrom(msg.sender, address(this), swapIntent.amountUserSells);
        } else {
            if (msg.value < swapIntent.amountUserSells) revert InsufficientNativeValue();
            if (msg.value > swapIntent.amountUserSells) {
                _sendNative(msg.sender, msg.value - swapIntent.amountUserSells);
            }
        }
    }

    function _handleFeeCollection(SwapIntent calldata swapIntent, FeeCollection calldata feeCollection)
        internal returns (uint256 effectiveAmountIn)
    {
        if (!feeCollection.isInTokenFee) return swapIntent.amountUserSells;
        return swapIntent.amountUserSells - _collectFees(
            swapIntent.tokenUserSells, swapIntent.amountUserSells, feeCollection
        );
    }

    /// @dev Shared by the input- and output-token fee paths so the two can never drift.
    function _collectFees(address token, uint256 base, FeeCollection calldata feeCollection)
        internal returns (uint256 totalFee)
    {
        if (feeCollection.feeBps == 0 && feeCollection.referrerFeeBps == 0) return 0;

        uint256 mainFee = (base * feeCollection.feeBps) / MAX_BPS;
        uint256 refFee  = (base * feeCollection.referrerFeeBps) / MAX_BPS;
        totalFee = mainFee + refFee;

        if (mainFee > 0) _payout(token, feeCollection.feeCollectorAddress, mainFee);
        if (refFee  > 0) _payout(token, feeCollection.referrerAddress,     refFee);

        emit FeeCollected(
            feeCollection.feeCollectorAddress, mainFee,
            feeCollection.referrerAddress,     refFee,
            msg.sender, token
        );
    }

    function _payout(address token, address to, uint256 amount) internal {
        if (token == NATIVE_TOKEN) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    function _executeAGGFlowSwap(address tokenIn, uint256 amountIn, address tokenOut, bytes calldata program)
        internal returns (uint256 amountOut)
    {
        address router = AGGFlowRouter;
        if (tokenIn != NATIVE_TOKEN) IERC20(tokenIn).forceApprove(router, amountIn);

        // minAmountOut is validated here after fees, not inside the router.
        amountOut = IAGGFlowRouter(router).executeRoute{
            value: tokenIn == NATIVE_TOKEN ? amountIn : 0
        }(tokenIn, amountIn, tokenOut, 0, program);

        if (tokenIn != NATIVE_TOKEN) IERC20(tokenIn).forceApprove(router, 0);
    }

    function _handleOutputAndTransfer(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        uint256 totalAmountOut,
        address receiver
    ) internal returns (uint256 amountOut) {
        amountOut = feeCollection.isInTokenFee
            ? totalAmountOut
            : totalAmountOut - _collectFees(swapIntent.tokenUserBuys, totalAmountOut, feeCollection);

        if (amountOut < swapIntent.minAmountUserBuys) revert InsufficientAmountAfterFees();
        _payout(swapIntent.tokenUserBuys, receiver, amountOut);
    }

    function version() external pure virtual returns (string memory) { return "1.0.0"; }

    receive() external payable {}
}
