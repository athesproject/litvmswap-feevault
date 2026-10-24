// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../utils/ReentrancyGuardUpgradeable.sol";
import "./AggregatorTypes.sol";

interface IAggregatorRouter {
    function executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256 minAmountOut,
        bytes calldata program
    ) external payable returns (uint256 amountOut);
}

/**
 * @title AggregatorEntrypoint  v2.0.0
 * @notice Entry point for aggregator swaps on LitVMSwap. It takes the caller's input, charges the protocol fee
 *         (paid to the fee vault, between a minimum and a maximum) and an optional integrator fee (capped), runs the
 *         route on the aggregator router and delivers the output to the receiver.
 *
 * Measured, not assumed (audit ATH-08): fees and the swap use the input that actually arrived, the output is what
 * the router actually delivered, and the minimum is checked against what the receiver actually got. A token that
 * takes a fee on transfer can therefore never make this contract spend or report more than it has. Nothing stays
 * here after a swap: an input that is not fully spent reverts the swap.
 *
 * Fee policy (audit ATH-11): the protocol fee must go to `requiredFeeCollector` and lie between `minFeeBps` and
 * `maxFeeBps`; the integrator fee is chosen by the integrator and capped at `maxReferrerFeeBps`.
 *
 * Upgrade of the 1.0.0 implementation behind the LitVM proxy: the storage layout is the same (two fields taken
 * from the gap), and so are the swap functions, structs and events the website, partner API and points wrapper use.
 */
contract AggregatorEntrypoint is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    address internal constant NATIVE_TOKEN = address(0);
    uint256 public  constant MAX_BPS       = 10_000;

    /// @custom:oz-renamed-from AGGFlowRouter
    address private _router;

    /// @notice Every swap must pay the protocol fee here. address(0) disables the check.
    address public requiredFeeCollector;
    /// @notice Minimum protocol fee in basis points.
    uint256 public minFeeBps;
    /// @notice Maximum protocol fee in basis points (2.0.0).
    uint256 public maxFeeBps;
    /// @notice Maximum integrator (referrer) fee in basis points (2.0.0).
    uint256 public maxReferrerFeeBps;

    uint256[30] private __gap;

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
    event FeeCapsUpdated(uint256 maxFeeBps, uint256 maxReferrerFeeBps);

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
    // 2.0.0
    error FeeAboveMaximum();
    error ReferrerFeeAboveMaximum();
    error InvalidReceiver();
    error UnexpectedNativeValue();
    error NothingReceived();
    error InputNotSpent();
    error NativeNotAccepted();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /**
     * @notice Setup of a new proxy. The LitVM proxy was set up by 1.0.0 and takes `initializeV2` instead.
     * @param owner_                Admin: router, fee policy, fee caps and upgrades
     * @param router_               Aggregator router that executes routes
     * @param requiredFeeCollector_ Fee vault, the only address allowed to take the protocol fee
     * @param minFeeBps_            Minimum protocol fee, 5 = 0.05%
     * @param maxFeeBps_            Maximum protocol fee
     * @param maxReferrerFeeBps_    Maximum integrator fee
     */
    function initialize(
        address owner_,
        address router_,
        address requiredFeeCollector_,
        uint256 minFeeBps_,
        uint256 maxFeeBps_,
        uint256 maxReferrerFeeBps_
    ) external initializer {
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        _setRouter(router_);
        requiredFeeCollector = requiredFeeCollector_;
        minFeeBps = minFeeBps_;
        emit FeePolicyUpdated(requiredFeeCollector_, minFeeBps_);
        _setFeeCaps(maxFeeBps_, maxReferrerFeeBps_);
    }

    /// @notice 1.0.0 to 2.0.0: sets the fee caps. Called by the owner in the same transaction as the upgrade.
    function initializeV2(uint256 maxFeeBps_, uint256 maxReferrerFeeBps_) external reinitializer(2) onlyOwner {
        _setFeeCaps(maxFeeBps_, maxReferrerFeeBps_);
    }

    // ── Admin ───────────────────────────────────────────────────────────────

    function getRouter() external view returns (address) { return _router; }

    function setRouter(address newRouter) external onlyOwner { _setRouter(newRouter); }

    /**
     * @notice Where the protocol fee must go and the floor it must meet.
     * @dev The floor can never exceed the cap. Setting a required collector with a zero floor still lets a caller
     *      pass feeBps = 0 and pay nothing, so set both together.
     */
    function setFeePolicy(address requiredFeeCollector_, uint256 minFeeBps_) external onlyOwner {
        if (minFeeBps_ > maxFeeBps) revert InvalidFeeStructure();
        requiredFeeCollector = requiredFeeCollector_;
        minFeeBps            = minFeeBps_;
        emit FeePolicyUpdated(requiredFeeCollector_, minFeeBps_);
    }

    function setFeeCaps(uint256 maxFeeBps_, uint256 maxReferrerFeeBps_) external onlyOwner {
        _setFeeCaps(maxFeeBps_, maxReferrerFeeBps_);
    }

    function _setRouter(address newRouter) internal {
        if (newRouter.code.length == 0) revert InvalidRouter();
        emit RouterUpdated(_router, newRouter);
        _router = newRouter;
    }

    function _setFeeCaps(uint256 maxFeeBps_, uint256 maxReferrerFeeBps_) internal {
        if (maxFeeBps_ < minFeeBps || maxFeeBps_ + maxReferrerFeeBps_ > MAX_BPS) revert InvalidFeeStructure();
        maxFeeBps         = maxFeeBps_;
        maxReferrerFeeBps = maxReferrerFeeBps_;
        emit FeeCapsUpdated(maxFeeBps_, maxReferrerFeeBps_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ── Swaps ───────────────────────────────────────────────────────────────

    function executeSwap(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program
    ) external payable nonReentrant returns (uint256 amountOut) {
        return _swap(swapIntent, feeCollection, program, msg.sender);
    }

    /// @notice Same as executeSwap, but the output goes to `receiver`. The input always comes from msg.sender.
    function executeSwapWithReceiver(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program,
        address receiver
    ) external payable nonReentrant returns (uint256 amountOut) {
        return _swap(swapIntent, feeCollection, program, receiver);
    }

    /// @return delivered What the receiver actually got
    function _swap(
        SwapIntent calldata swapIntent,
        FeeCollection calldata feeCollection,
        bytes calldata program,
        address receiver
    ) internal returns (uint256 delivered) {
        address tokenIn  = swapIntent.tokenUserSells;
        address tokenOut = swapIntent.tokenUserBuys;
        if (tokenIn == tokenOut) revert BuyAndSellTokensAreSame();
        if (receiver == address(0) || receiver == address(this)) revert InvalidReceiver();
        _validateFeeStructure(feeCollection);

        // What this contract held before the call (for native, msg.value has already arrived).
        uint256 heldBefore = _balance(tokenIn) - (tokenIn == NATIVE_TOKEN ? msg.value : 0);
        uint256 received = _pullInput(tokenIn, swapIntent.amountUserSells);

        uint256 swapAmount = received;
        if (feeCollection.isInTokenFee) swapAmount -= _collectFees(tokenIn, received, feeCollection);

        uint256 produced = _runRoute(tokenIn, swapAmount, tokenOut, program);
        if (_balance(tokenIn) != heldBefore) revert InputNotSpent();

        uint256 amountOut = produced;
        if (!feeCollection.isInTokenFee) amountOut -= _collectFees(tokenOut, produced, feeCollection);

        delivered = _deliver(tokenOut, receiver, amountOut);
        if (delivered < swapIntent.minAmountUserBuys) revert InsufficientAmountAfterFees();

        emit AGGFlowSwap(
            msg.sender,
            feeCollection.referrerAddress,
            tokenIn,
            tokenOut,
            feeCollection.isInTokenFee,
            received,
            delivered,
            feeCollection.referrerFeeBps,
            feeCollection.feeBps + feeCollection.referrerFeeBps
        );
    }

    function _validateFeeStructure(FeeCollection calldata feeCollection) internal view {
        if (feeCollection.feeBps + feeCollection.referrerFeeBps > MAX_BPS) revert InvalidFeeStructure();
        if (feeCollection.feeBps > 0 && feeCollection.feeCollectorAddress == address(0)) revert InvalidFeeCollector();
        if (feeCollection.referrerFeeBps > 0 && feeCollection.referrerAddress == address(0)) revert InvalidReferrer();

        address required = requiredFeeCollector;
        if (required != address(0) && feeCollection.feeCollectorAddress != required) revert FeeCollectorNotAllowed();
        if (feeCollection.feeBps < minFeeBps) revert FeeBelowMinimum();
        if (feeCollection.feeBps > maxFeeBps) revert FeeAboveMaximum();
        if (feeCollection.referrerFeeBps > maxReferrerFeeBps) revert ReferrerFeeAboveMaximum();
    }

    /// @return received The input that actually arrived
    function _pullInput(address tokenIn, uint256 amount) internal returns (uint256 received) {
        if (amount == 0) revert NothingReceived();
        if (tokenIn == NATIVE_TOKEN) {
            if (msg.value < amount) revert InsufficientNativeValue();
            if (msg.value > amount) _sendNative(msg.sender, msg.value - amount);
            return amount;
        }
        // Native sent with a token sale would be stranded here.
        if (msg.value != 0) revert UnexpectedNativeValue();
        uint256 before = IERC20(tokenIn).balanceOf(address(this));
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(tokenIn).balanceOf(address(this)) - before;
        if (received == 0) revert NothingReceived();
    }

    /// @return produced The output the router actually delivered to this contract
    function _runRoute(address tokenIn, uint256 amountIn, address tokenOut, bytes calldata program)
        internal returns (uint256 produced)
    {
        address router = _router;
        uint256 before = _balance(tokenOut);
        if (tokenIn != NATIVE_TOKEN) IERC20(tokenIn).forceApprove(router, amountIn);

        // The minimum is checked after fees, on what the receiver gets, not inside the router.
        IAggregatorRouter(router).executeRoute{ value: tokenIn == NATIVE_TOKEN ? amountIn : 0 }(
            tokenIn, amountIn, tokenOut, 0, program
        );

        if (tokenIn != NATIVE_TOKEN) IERC20(tokenIn).forceApprove(router, 0);
        produced = _balance(tokenOut) - before;
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

    /// @return delivered What the receiver's balance went up by (the amount itself for native)
    function _deliver(address token, address receiver, uint256 amount) internal returns (uint256 delivered) {
        if (token == NATIVE_TOKEN) {
            _sendNative(receiver, amount);
            return amount;
        }
        uint256 before = IERC20(token).balanceOf(receiver);
        IERC20(token).safeTransfer(receiver, amount);
        delivered = IERC20(token).balanceOf(receiver) - before;
    }

    function _payout(address token, address to, uint256 amount) internal {
        if (token == NATIVE_TOKEN) _sendNative(to, amount);
        else IERC20(token).safeTransfer(to, amount);
    }

    function _sendNative(address to, uint256 amount) internal {
        (bool ok, ) = payable(to).call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    function _balance(address token) internal view returns (uint256) {
        return token == NATIVE_TOKEN ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function version() external pure virtual returns (string memory) { return "2.0.0"; }

    /// @dev Native arrives only as router output.
    receive() external payable {
        if (msg.sender != _router) revert NativeNotAccepted();
    }
}
