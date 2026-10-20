// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title Minimal IUniswapV3Pool interface for vault protocol fee collection
interface IUniswapV3Pool {
    /// @notice Set the protocol's % share of the swap fee for both tokens of the pool.
    /// @dev Only callable by the factory owner.
    /// @param feeProtocol0 new protocol fee for token0 (0 = disabled, 4-10 = 1/N)
    /// @param feeProtocol1 new protocol fee for token1 (0 = disabled, 4-10 = 1/N)
    function setFeeProtocol(uint8 feeProtocol0, uint8 feeProtocol1) external;

    /// @notice Collect the protocol fee accrued to the pool.
    /// @dev Only callable by the factory owner.
    /// @param recipient address to send collected fees to
    /// @param amount0Requested max token0 to collect (use type(uint128).max for all)
    /// @param amount1Requested max token1 to collect (use type(uint128).max for all)
    /// @return amount0 amount of token0 collected
    /// @return amount1 amount of token1 collected
    function collectProtocol(
        address recipient,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external returns (uint128 amount0, uint128 amount1);

    /// @notice Returns the current state of the pool
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );

    /// @notice Accumulated protocol fees in token0/token1 units
    function protocolFees() external view returns (uint128 token0, uint128 token1);

    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
}
