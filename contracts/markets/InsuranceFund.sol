// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title InsuranceFund
/// @notice USDR reserve backstopping perp bad debt. Only the PerpClearing (DRAWER_ROLE) can draw,
///         and `cover` never reverts on insufficient balance (it caps to the balance) so it can
///         never stall a liquidation. Funded by liquidation penalties + admin seeding.
contract InsuranceFund is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable token; // USDR

    event Covered(address indexed to, uint256 requested, uint256 paid);
    event SurplusWithdrawn(address indexed to, uint256 amount);

    constructor(address admin, address token_) {
        if (admin == address(0) || token_ == address(0)) revert Errors.ZeroAddress();
        token = IERC20(token_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Draw up to `amount` to `to`; returns the actual amount paid (capped at balance).
    function cover(address to, uint256 amount) external onlyRole(Roles.DRAWER_ROLE) nonReentrant returns (uint256 paid) {
        uint256 bal = token.balanceOf(address(this));
        paid = amount > bal ? bal : amount;
        if (paid > 0) token.safeTransfer(to, paid);
        emit Covered(to, amount, paid);
    }

    function withdrawSurplus(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (to == address(0)) revert Errors.ZeroAddress();
        token.safeTransfer(to, amount);
        emit SurplusWithdrawn(to, amount);
    }

    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
