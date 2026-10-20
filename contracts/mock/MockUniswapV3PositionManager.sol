// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../interfaces/INonfungiblePositionManager.sol";

contract MockUniswapV3PositionManager is INonfungiblePositionManager {
    address public token0;
    address public token1;

    constructor(address _token0, address _token1) {
        token0 = _token0;
        token1 = _token1;
    }

    function collect(CollectParams calldata params) external payable override returns (uint256 amount0, uint256 amount1) {
        amount0 = params.amount0Max > 1000 ? 1000 : params.amount0Max;
        amount1 = params.amount1Max > 2000 ? 2000 : params.amount1Max;

        IERC20(token0).transfer(params.recipient, amount0);
        IERC20(token1).transfer(params.recipient, amount1);
    }

    function positions(uint256 /*tokenId*/) external view override returns (
        uint96 nonce,
        address operator,
        address _token0,
        address _token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0,
        uint128 tokensOwed1
    ) {
        return (0, address(0), token0, token1, 3000, -60, 60, 10000, 0, 0, 1000, 2000);
    }
}
