// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Capped} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Capped.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title WFT — WeBlock Token
/// @notice Governance-enabled (ERC20Votes) loyalty token, minted only at TGE by an authorized
///         minter (the WftClaim contract). Capped supply, no pre-distribution. Supports lock
///         schedules (whale vesting / TGE tracks). Utility/consumable framing — NO financial rights.
contract WFT is ERC20, ERC20Capped, ERC20Pausable, ERC20Permit, ERC20Votes, AccessControl {
    struct Lock {
        uint256 amount;
        uint64 unlockAt;
        bool revocable;
        bool revoked;
    }

    mapping(address => Lock[]) private _locks;

    event Locked(address indexed account, uint256 lockId, uint256 amount, uint64 unlockAt, bool revocable);
    event LockRevoked(address indexed account, uint256 lockId, uint256 amount);

    constructor(address admin, uint256 cap_)
        ERC20("WeBlock Token", "WFT")
        ERC20Capped(cap_)
        ERC20Permit("WeBlock Token")
    {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.MINTER_ROLE, admin);
        _grantRole(Roles.LOCK_MANAGER_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(Roles.MINTER_ROLE) {
        _mint(to, amount);
    }

    /// @notice Mint `amount` to `account`, locked until `unlockAt`.
    function mintLocked(address account, uint256 amount, uint64 unlockAt, bool revocable)
        external
        onlyRole(Roles.LOCK_MANAGER_ROLE)
        returns (uint256 lockId)
    {
        if (amount == 0) revert Errors.ZeroAmount();
        _mint(account, amount);
        _locks[account].push(Lock(amount, unlockAt, revocable, false));
        lockId = _locks[account].length - 1;
        emit Locked(account, lockId, amount, unlockAt, revocable);
    }

    /// @notice Revoke a still-locked, revocable lock by burning the locked amount from `account`.
    function revokeLock(address account, uint256 lockId) external onlyRole(Roles.LOCK_MANAGER_ROLE) {
        Lock storage l = _locks[account][lockId];
        if (l.revoked || !l.revocable || block.timestamp >= l.unlockAt) revert Errors.InvalidState();
        l.revoked = true;
        _burn(account, l.amount);
        emit LockRevoked(account, lockId, l.amount);
    }

    function lockedBalanceOf(address account) public view returns (uint256 locked) {
        Lock[] storage ls = _locks[account];
        for (uint256 i; i < ls.length; ++i) {
            if (!ls[i].revoked && block.timestamp < ls[i].unlockAt) locked += ls[i].amount;
        }
    }

    function locksOf(address account) external view returns (Lock[] memory) {
        return _locks[account];
    }

    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PAUSER_ROLE) {
        _unpause();
    }

    // Enforce locks: free (transferable) balance = balanceOf - lockedBalanceOf.
    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Capped, ERC20Pausable, ERC20Votes)
    {
        if (from != address(0)) {
            uint256 locked = lockedBalanceOf(from);
            if (locked > 0 && balanceOf(from) - value < locked) revert Errors.TransferNotAllowed();
        }
        super._update(from, to, value);
    }

    function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
