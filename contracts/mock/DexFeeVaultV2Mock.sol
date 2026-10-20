// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../DexFeeVaultUpgradeable.sol";

/**
 * @title DexFeeVaultV2Mock
 * @notice Mock upgraded version of DexFeeVaultUpgradeable to test UUPS proxy upgrades
 */
contract DexFeeVaultV2Mock is DexFeeVaultUpgradeable {
    uint256 public customV2Variable;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @custom:oz-upgrades-validate-as-initializer
     */
    function initializeV2(uint256 initialV2Value) external reinitializer(2) {
        __ReentrancyGuard_init();
        customV2Variable = initialV2Value;
    }

    function setCustomV2Variable(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        customV2Variable = value;
    }

    function version() external pure override returns (string memory) {
        return "2.0.0";
    }
}
