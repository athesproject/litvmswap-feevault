// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../interfaces/IUniswapV2Factory.sol";

contract MockUniswapV2Factory is IUniswapV2Factory {
    address[] public pairs;
    address public override feeTo;

    function addPair(address pair) external { pairs.push(pair); }
    function setFeeTo(address _feeTo) external { feeTo = _feeTo; }

    function allPairsLength() external view override returns (uint256) { return pairs.length; }
    function allPairs(uint256 i) external view override returns (address) { return pairs[i]; }
}
