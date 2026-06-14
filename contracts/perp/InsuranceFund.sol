// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title InsuranceFund
/// @notice Backstop reserve (denominated in the quote token, USDR) that absorbs
///         bad debt when a liquidated position's loss exceeds its posted margin.
///         RBT is illiquid, so liquidation gaps are a real risk and ADL alone may
///         not suffice — the fund is the first line of defence before socialised
///         loss. Liquidation penalties and a slice of trading fees flow in here.
/// @dev    Only an authorised drawer (the PerpClearing contract) may pull funds,
///         and only up to the available balance.
contract InsuranceFund is AccessControl {
    using SafeERC20 for IERC20;

    /// @dev Role allowed to draw funds to cover bad debt — granted to PerpClearing.
    bytes32 public constant DRAWER_ROLE = keccak256("DRAWER_ROLE");

    IERC20 public immutable quoteToken;

    event Funded(address indexed from, uint256 amount);
    event Drawn(address indexed to, uint256 amount, uint256 requested);
    event Withdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();

    constructor(address admin, address quoteToken_) {
        if (admin == address(0) || quoteToken_ == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        quoteToken = IERC20(quoteToken_);
    }

    /// @notice Top up the fund. Caller must have approved `amount` to this contract.
    function fund(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(msg.sender, amount);
    }

    /// @notice Current reserve balance.
    function balance() public view returns (uint256) {
        return quoteToken.balanceOf(address(this));
    }

    /// @notice Draw up to `amount` to `to` to cover bad debt. Returns the amount
    ///         actually transferred (capped at the available balance so the draw
    ///         can never revert and stall a liquidation).
    function cover(
        address to,
        uint256 amount
    ) external onlyRole(DRAWER_ROLE) returns (uint256 paid) {
        if (to == address(0)) revert ZeroAddress();
        uint256 available = balance();
        paid = amount > available ? available : amount;
        if (paid > 0) {
            quoteToken.safeTransfer(to, paid);
        }
        emit Drawn(to, paid, amount);
    }

    /// @notice Admin withdrawal of surplus reserves (e.g. to treasury).
    function withdraw(
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        quoteToken.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }
}
