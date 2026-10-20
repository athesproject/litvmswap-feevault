// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IUniswapV2Factory {
    function allPairsLength() external view returns (uint256);
    function allPairs(uint256 index) external view returns (address);
    function feeTo() external view returns (address);
}
