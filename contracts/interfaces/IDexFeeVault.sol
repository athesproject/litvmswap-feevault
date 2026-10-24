// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IDexFeeVault {
    struct Beneficiary {
        bytes32 id;         // Unique beneficiary identifier (e.g. keccak256("PARTNERS"))
        address wallet;     // Wallet address to receive or claim funds
        uint16 bps;         // Basis points allocation share (10000 = 100.00%)
        bool isActive;      // Active status indicator
        string name;        // Human readable label ("Partners", "Core Team", etc.)
    }

    struct BeneficiaryInput {
        bytes32 id;
        address wallet;
        uint16 bps;
        string name;
    }

    // Events
    event FeeReceived(address indexed sender, uint256 amount);
    event FeeDeposited(address indexed token, address indexed sender, uint256 amount);
    event UniswapV3FeeCollected(
        address indexed positionManager,
        uint256 indexed tokenId,
        address indexed recipient,
        uint256 amount0,
        uint256 amount1
    );
    event UniswapV2FeeCollected(
        address indexed pair,
        address indexed token0,
        address indexed token1,
        uint256 amount0,
        uint256 amount1
    );
    event BeneficiaryUpdated(bytes32 indexed id, address indexed wallet, uint16 bps, string name);
    event BeneficiaryRemoved(bytes32 indexed id);
    event FeesDistributed(address indexed token, uint256 totalAmount, bool autoPushed);
    event FeesClaimed(address indexed beneficiary, address indexed token, uint256 amount);
    event EmergencyWithdrawal(address indexed token, address indexed recipient, uint256 amount);
    event PublicDistributionToggled(bool allowed);

    // Custom Errors
    error InvalidBpsTotal(uint16 current, uint16 expected);
    error InvalidAddress();
    error InvalidBeneficiary();
    error BeneficiaryNotFound(bytes32 id);
    error TransferFailed();
    error NoFeesToDistribute();
    error DistributionNotAllowed();
    error ZeroAmount();

    // Functions
    function depositAggregatorFee(address token, uint256 amount, bytes calldata metadata) external payable;
    
    function setBeneficiary(bytes32 id, address wallet, uint16 bps, string calldata name) external;
    function setPublicDistributionAllowed(bool allowed) external;

    function distributeETH(bool autoPush) external;
    function distributeToken(address token, bool autoPush) external;

    function claimETH() external;
    function claimToken(address token) external;
    function claimAll(address[] calldata tokens, bool includeETH) external;

    function getBeneficiary(bytes32 id) external view returns (Beneficiary memory);
    function getAllBeneficiaryIds() external view returns (bytes32[] memory);
    function version() external pure returns (string memory);
}
