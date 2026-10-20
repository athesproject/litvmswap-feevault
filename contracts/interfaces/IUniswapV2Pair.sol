// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function swap(uint amount0Out, uint amount1Out, address to, bytes calldata data) external;
    function skim(address to) external;
    function sync() external;

    // ── LP token surface ───────────────────────────────────────────────────
    // factory.feeTo mints LP *tokens* to the vault on mint()/burn(). Redeeming
    // them into the underlying pair reserves requires transfer + burn, which is
    // the only way V2 protocol fees ever become spendable revenue.
    function balanceOf(address owner) external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 value) external returns (bool);
    function burn(address to) external returns (uint256 amount0, uint256 amount1);
}
