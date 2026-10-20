// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IVaultDistribute {
    function distributeRegistered(bool autoPush) external;
}

/// @dev Beneficiary that tries to re-enter distribution while it is being paid (audit V1).
contract ReentrantBeneficiary {
    IVaultDistribute public immutable vault;
    uint256 public attempts;
    uint256 public reentered;

    constructor(address v) { vault = IVaultDistribute(v); }

    receive() external payable {
        attempts++;
        try vault.distributeRegistered(true) { reentered++; } catch {}
    }
}

/// @dev A registered token that cannot report a balance or move (a paused or broken token, audit V2).
contract BrokenToken {
    function balanceOf(address) external pure returns (uint256) { revert("broken"); }
    function transfer(address, uint256) external pure returns (bool) { revert("broken"); }
}

/// @dev ERC-20 that refuses transfers to blocked addresses (a blacklist, audit V2 and claimFor).
contract BlockingToken is ERC20 {
    mapping(address => bool) public blocked;

    constructor() ERC20("Blocking", "BLK") {}

    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address who, bool b) external { blocked[who] = b; }

    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "BlockingToken: recipient blocked");
        super._update(from, to, value);
    }
}

/// @dev V3 factory surface the vault relies on: getPool proves a pool is real (audit V9),
///      setOwner is something factoryCall may reach (audit V5).
contract MockUniswapV3Factory {
    mapping(address => mapping(address => mapping(uint24 => address))) public getPool;
    address public owner;

    function register(address pool, address t0, address t1, uint24 fee) external {
        getPool[t0][t1][fee] = pool;
        getPool[t1][t0][fee] = pool;
    }

    function setOwner(address o) external { owner = o; }
}
