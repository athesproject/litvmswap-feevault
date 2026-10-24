// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice What the user sells and buys. The field order is part of the ABI the website, the partner API and the
///         points wrapper encode, so it must not change.
struct SwapIntent {
    address tokenUserBuys;     // output token, address(0) for native
    uint256 minAmountUserBuys; // minimum the receiver must get, after fees
    address tokenUserSells;    // input token, address(0) for native
    uint256 amountUserSells;   // input taken from the caller
}

/// @notice Fees for one swap: the protocol fee (to the fee vault) and an optional integrator (referrer) fee.
struct FeeCollection {
    address feeCollectorAddress; // protocol fee recipient, must be the entrypoint's required collector
    uint256 feeBps;              // protocol fee, between the entrypoint's minimum and maximum
    address referrerAddress;     // integrator fee recipient, chosen by the integrator
    uint256 referrerFeeBps;      // integrator fee, at most the entrypoint's referrer cap
    bool isInTokenFee;           // true: fees taken from the input, false: from the output
}
