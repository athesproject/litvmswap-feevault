// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "../entrypoint/AggregatorTypes.sol";

/// @dev Burns 1% of every transfer (a deflationary token, audit ATH-08).
contract FeeOnTransferERC20 is ERC20 {
    constructor() ERC20("Fee on transfer", "FOT") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 burned = value / 100;
            super._update(from, address(0), burned);
            value -= burned;
        }
        super._update(from, to, value);
    }
}

/// @dev Router that takes only half of what it was approved for, so input would stay in the entrypoint.
contract PartialPullRouter {
    uint256 public outputAmount;

    function setOutputAmount(uint256 a) external { outputAmount = a; }

    function executeRoute(address tokenIn, uint256 amountIn, address tokenOut, uint256, bytes calldata)
        external payable returns (uint256)
    {
        IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn / 2);
        IERC20(tokenOut).transfer(msg.sender, outputAmount);
        return outputAmount;
    }
}

interface IEntrypointSwap {
    function executeSwap(SwapIntent calldata, FeeCollection calldata, bytes calldata) external payable returns (uint256);
}

/// @dev Router that calls back into the entrypoint while a swap is running.
contract ReenteringRouter {
    function executeRoute(address tokenIn, uint256, address tokenOut, uint256, bytes calldata)
        external payable returns (uint256)
    {
        SwapIntent memory s = SwapIntent(tokenOut, 0, tokenIn, 1);
        FeeCollection memory f = FeeCollection(address(0), 0, address(0), 0, true);
        return IEntrypointSwap(msg.sender).executeSwap(s, f, "");
    }
}
