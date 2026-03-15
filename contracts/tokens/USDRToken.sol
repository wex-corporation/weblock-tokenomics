// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

contract USDRToken is
    ERC20,
    ERC20Burnable,
    ERC20Permit,
    AccessControl,
    Pausable
{
    uint8 private constant USDR_DECIMALS = 6;

    constructor(
        address admin,
        address treasury,
        uint256 initialMint
    ) ERC20("USD Real Estate", "USDR") ERC20Permit("USD Real Estate") {
        if (admin == address(0) || treasury == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.MINTER_ROLE, admin);
        _grantRole(WeBlockRoles.PAUSER_ROLE, admin);

        if (initialMint != 0) {
            _mint(treasury, initialMint);
        }
    }

    function decimals() public pure override returns (uint8) {
        return USDR_DECIMALS;
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
        _mint(to, amount);
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override whenNotPaused {
        super._update(from, to, value);
    }
}
