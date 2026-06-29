// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title USDR — WeBlock USD settlement stablecoin
/// @notice 6-decimal stablecoin used for rent payouts, perp margin/settlement, and spot quote.
///         Mintable by MINTER_ROLE (backend faucet on testnet; treasury process on mainnet).
contract USDR is ERC20, ERC20Burnable, ERC20Pausable, ERC20Permit, AccessControl {
    constructor(address admin, uint256 initialSupply, address treasury)
        ERC20("WeBlock USD", "USDR")
        ERC20Permit("WeBlock USD")
    {
        if (admin == address(0) || treasury == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.MINTER_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, admin);
        if (initialSupply > 0) _mint(treasury, initialSupply);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyRole(Roles.MINTER_ROLE) {
        _mint(to, amount);
    }

    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PAUSER_ROLE) {
        _unpause();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }
}
