// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Nonces} from "@openzeppelin/contracts/utils/Nonces.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

contract WFTToken is ERC20, ERC20Permit, ERC20Votes, AccessControl, Pausable {
    struct LockSchedule {
        uint128 amount;
        uint64 unlockTime;
        bool active;
        string memo;
    }

    uint256 public immutable maxSupply;

    mapping(address => LockSchedule[]) private _locks;
    mapping(address => uint256) public lockedBalance;

    event LockCreated(
        address indexed account,
        uint256 indexed lockId,
        uint256 amount,
        uint256 unlockTime,
        string memo
    );
    event LockReleased(
        address indexed account,
        uint256 indexed lockId,
        uint256 amount
    );
    event LockRevoked(
        address indexed account,
        uint256 indexed lockId,
        uint256 amount
    );
    event AirdropExecuted(uint256 recipients, uint256 totalAmount);

    constructor(
        address admin,
        address treasury,
        uint256 cap_,
        uint256 initialTreasuryMint
    )
        ERC20("WeBlock Foundation Token", "WFT")
        ERC20Permit("WeBlock Foundation Token")
    {
        if (admin == address(0) || treasury == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }
        if (cap_ == 0 || initialTreasuryMint > cap_) {
            revert WeBlockErrors.QuantityTooHigh();
        }

        maxSupply = cap_;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.MINTER_ROLE, admin);
        _grantRole(WeBlockRoles.PAUSER_ROLE, admin);
        _grantRole(WeBlockRoles.LOCK_MANAGER_ROLE, admin);
        _grantRole(WeBlockRoles.AIRDROP_ROLE, admin);

        if (initialTreasuryMint != 0) {
            _mint(treasury, initialTreasuryMint);
        }
    }

    function pause() external onlyRole(WeBlockRoles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(WeBlockRoles.PAUSER_ROLE) {
        _unpause();
    }

    function mint(
        address to,
        uint256 amount
    ) external onlyRole(WeBlockRoles.MINTER_ROLE) {
        _mintWithCap(to, amount);
    }

    function mintLocked(
        address to,
        uint256 amount,
        uint64 unlockTime,
        string calldata memo
    ) external onlyRole(WeBlockRoles.LOCK_MANAGER_ROLE) {
        _mintWithCap(to, amount);
        _createLock(to, amount, unlockTime, memo);
    }

    function airdrop(
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyRole(WeBlockRoles.AIRDROP_ROLE) {
        if (recipients.length != amounts.length) {
            revert WeBlockErrors.InvalidArrayLength();
        }

        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            total += amounts[i];
            _mintWithCap(recipients[i], amounts[i]);
        }

        emit AirdropExecuted(recipients.length, total);
    }

    function airdropLocked(
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint64 unlockTime,
        string calldata memo
    ) external onlyRole(WeBlockRoles.AIRDROP_ROLE) {
        if (recipients.length != amounts.length) {
            revert WeBlockErrors.InvalidArrayLength();
        }

        uint256 total;
        for (uint256 i = 0; i < recipients.length; i++) {
            total += amounts[i];
            _mintWithCap(recipients[i], amounts[i]);
            _createLock(recipients[i], amounts[i], unlockTime, memo);
        }

        emit AirdropExecuted(recipients.length, total);
    }

    function createLock(
        address account,
        uint256 amount,
        uint64 unlockTime,
        string calldata memo
    ) external onlyRole(WeBlockRoles.LOCK_MANAGER_ROLE) {
        if (balanceOf(account) - lockedBalance[account] < amount) {
            revert WeBlockErrors.InsufficientUnlockedBalance();
        }

        _createLock(account, amount, unlockTime, memo);
    }

    function releaseUnlockedLocks(
        address account,
        uint256[] calldata lockIds
    ) external {
        for (uint256 i = 0; i < lockIds.length; i++) {
            _releaseLock(account, lockIds[i], false);
        }
    }

    function revokeLock(
        address account,
        uint256 lockId
    ) external onlyRole(WeBlockRoles.LOCK_MANAGER_ROLE) {
        _releaseLock(account, lockId, true);
    }

    function lockCount(address account) external view returns (uint256) {
        return _locks[account].length;
    }

    function lockInfo(
        address account,
        uint256 lockId
    ) external view returns (LockSchedule memory) {
        return _locks[account][lockId];
    }

    function unlockedBalanceOf(
        address account
    ) external view returns (uint256) {
        return balanceOf(account) - lockedBalance[account];
    }

    function _mintWithCap(address to, uint256 amount) private {
        if (totalSupply() + amount > maxSupply) {
            revert WeBlockErrors.QuantityTooHigh();
        }
        _mint(to, amount);
    }

    function _createLock(
        address account,
        uint256 amount,
        uint64 unlockTime,
        string memory memo
    ) private {
        if (account == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }
        if (unlockTime <= block.timestamp || amount == 0) {
            revert WeBlockErrors.LockNotReady();
        }

        _locks[account].push(
            LockSchedule({
                amount: uint128(amount),
                unlockTime: unlockTime,
                active: true,
                memo: memo
            })
        );
        lockedBalance[account] += amount;
        emit LockCreated(
            account,
            _locks[account].length - 1,
            amount,
            unlockTime,
            memo
        );
    }

    function _releaseLock(address account, uint256 lockId, bool force) private {
        LockSchedule storage schedule = _locks[account][lockId];
        if (!schedule.active) {
            revert WeBlockErrors.OrderClosed();
        }
        if (!force && block.timestamp < schedule.unlockTime) {
            revert WeBlockErrors.LockNotReady();
        }

        schedule.active = false;
        lockedBalance[account] -= schedule.amount;

        if (force) {
            emit LockRevoked(account, lockId, schedule.amount);
        } else {
            emit LockReleased(account, lockId, schedule.amount);
        }
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Votes) whenNotPaused {
        if (
            from != address(0) && value > balanceOf(from) - lockedBalance[from]
        ) {
            revert WeBlockErrors.InsufficientUnlockedBalance();
        }

        super._update(from, to, value);
    }

    function nonces(
        address owner
    ) public view override(ERC20Permit, Nonces) returns (uint256) {
        return super.nonces(owner);
    }
}
