// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IUniswapV2Pair.sol";

/**
 * @dev Mock V2 pair with a real LP-token surface, so the vault's protocol-fee
 *      redemption path (transfer LP in -> burn -> underlying out) can be tested
 *      the way it behaves against a live pair. Mirrors UniswapV2's rule that
 *      burn() reverts unless both legs come out non-zero.
 */
contract MockUniswapV2Pair is IUniswapV2Pair {
    address public override token0;
    address public override token1;

    uint256 public override totalSupply;
    mapping(address => uint256) public override balanceOf;

    bool public burnShouldRevert;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    // ── test helpers ───────────────────────────────────────────────────────
    function mintTo(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function setBurnShouldRevert(bool v) external { burnShouldRevert = v; }

    // ── LP token ───────────────────────────────────────────────────────────
    function transfer(address to, uint256 value) external override returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient LP");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    /// @dev Burns the LP the pair itself holds and pays out a pro-rata share.
    function burn(address to) external override returns (uint256 amount0, uint256 amount1) {
        require(!burnShouldRevert, "MockPair: forced revert");

        uint256 liquidity = balanceOf[address(this)];
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));

        amount0 = (liquidity * bal0) / totalSupply;
        amount1 = (liquidity * bal1) / totalSupply;
        require(amount0 > 0 && amount1 > 0, "UniswapV2: INSUFFICIENT_LIQUIDITY_BURNED");

        balanceOf[address(this)] = 0;
        totalSupply -= liquidity;

        IERC20(token0).transfer(to, amount0);
        IERC20(token1).transfer(to, amount1);
    }

    // ── pair surface ───────────────────────────────────────────────────────
    function getReserves()
        external
        view
        override
        returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)
    {
        return (
            uint112(IERC20(token0).balanceOf(address(this))),
            uint112(IERC20(token1).balanceOf(address(this))),
            uint32(block.timestamp)
        );
    }

    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external override {}

    /// @dev Real pairs only send the surplus above reserves; this mock keeps the
    ///      old behaviour of sweeping everything so existing tests still pass.
    function skim(address to) external override {
        uint256 bal0 = IERC20(token0).balanceOf(address(this));
        uint256 bal1 = IERC20(token1).balanceOf(address(this));
        if (bal0 > 0) IERC20(token0).transfer(to, bal0);
        if (bal1 > 0) IERC20(token1).transfer(to, bal1);
    }

    function sync() external override {}
}
