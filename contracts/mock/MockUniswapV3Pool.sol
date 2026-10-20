// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/IUniswapV3Pool.sol";

/// @dev Mock V3 pool with real protocol-fee accounting, so the vault's selective
///      collection path can be tested the way it behaves against a live pool.
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public override token0;
    address public override token1;
    uint24  public override fee;

    uint128 private pf0;
    uint128 private pf1;
    uint8   private feeProtocolPacked;
    bool    public collectShouldRevert;

    constructor(address _t0, address _t1, uint24 _fee) {
        token0 = _t0; token1 = _t1; fee = _fee;
    }

    // ── test helpers ───────────────────────────────────────────────────────
    function setProtocolFees(uint128 a0, uint128 a1) external { pf0 = a0; pf1 = a1; }
    function setCollectShouldRevert(bool v) external { collectShouldRevert = v; }

    // ── pool surface ───────────────────────────────────────────────────────
    function setFeeProtocol(uint8 f0, uint8 f1) external override {
        feeProtocolPacked = f0 + (f1 << 4);
    }

    function collectProtocol(address recipient, uint128 a0Max, uint128 a1Max)
        external override returns (uint128 amount0, uint128 amount1)
    {
        require(!collectShouldRevert, "MockPool: forced revert");
        amount0 = a0Max < pf0 ? a0Max : pf0;
        amount1 = a1Max < pf1 ? a1Max : pf1;
        pf0 -= amount0;
        pf1 -= amount1;
        if (amount0 > 0) IERC20(token0).transfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).transfer(recipient, amount1);
    }

    function protocolFees() external view override returns (uint128, uint128) { return (pf0, pf1); }

    function slot0() external view override returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (0, 0, 0, 0, 0, feeProtocolPacked, true);
    }
}
