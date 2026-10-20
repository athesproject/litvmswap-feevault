// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Stand-in for the AGGFlow router: takes tokenIn, pays out a configured
///      amount of tokenOut, so the entrypoint's fee maths can be exercised.
contract MockAGGFlowRouter {
    uint256 public outputAmount;

    function setOutputAmount(uint256 a) external { outputAmount = a; }

    function executeRoute(
        address tokenIn,
        uint256 amountIn,
        address tokenOut,
        uint256,
        bytes memory
    ) external payable returns (uint256) {
        if (tokenIn != address(0)) IERC20(tokenIn).transferFrom(msg.sender, address(this), amountIn);
        if (tokenOut != address(0)) IERC20(tokenOut).transfer(msg.sender, outputAmount);
        else { (bool ok, ) = payable(msg.sender).call{ value: outputAmount }(""); require(ok, "native out"); }
        return outputAmount;
    }

    receive() external payable {}
}
