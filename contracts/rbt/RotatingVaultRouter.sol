// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PaymentVault} from "./PaymentVault.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

contract RotatingVaultRouter is AccessControl {
    using SafeERC20 for IERC20;

    struct VaultSet {
        address activeVault;
        address[] vaults;
    }

    mapping(address => VaultSet) private _vaultsByAsset;

    event VaultCreated(
        address indexed asset,
        address indexed vault,
        bool active
    );
    event VaultActivated(address indexed asset, address indexed vault);
    event Funded(
        address indexed asset,
        address indexed from,
        address indexed vault,
        uint256 amount
    );
    event PaidOut(address indexed asset, address indexed to, uint256 amount);
    event Consolidated(
        address indexed asset,
        address indexed fromVault,
        address indexed toVault,
        uint256 amount
    );

    constructor(address admin) {
        if (admin == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.TREASURY_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.TREASURY_FUNDER_ROLE, admin);
        _grantRole(WeBlockRoles.CLAIMS_MANAGER_ROLE, admin);
    }

    function vaultCount(address asset) external view returns (uint256) {
        return _vaultsByAsset[asset].vaults.length;
    }

    function activeVault(address asset) external view returns (address) {
        return _vaultsByAsset[asset].activeVault;
    }

    function vaultAt(
        address asset,
        uint256 index
    ) external view returns (address) {
        return _vaultsByAsset[asset].vaults[index];
    }

    function createVault(
        address asset,
        bool makeActive
    )
        external
        onlyRole(WeBlockRoles.TREASURY_ADMIN_ROLE)
        returns (address vault)
    {
        if (asset == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        vault = address(new PaymentVault(address(this), asset));
        _vaultsByAsset[asset].vaults.push(vault);

        if (makeActive || _vaultsByAsset[asset].activeVault == address(0)) {
            _vaultsByAsset[asset].activeVault = vault;
            emit VaultActivated(asset, vault);
        }

        emit VaultCreated(
            asset,
            vault,
            makeActive || _vaultsByAsset[asset].activeVault == vault
        );
    }

    function activateVault(
        address asset,
        address vault
    ) external onlyRole(WeBlockRoles.TREASURY_ADMIN_ROLE) {
        if (!_containsVault(asset, vault)) {
            revert WeBlockErrors.InvalidVault();
        }

        _vaultsByAsset[asset].activeVault = vault;
        emit VaultActivated(asset, vault);
    }

    function fundFrom(
        address asset,
        address from,
        uint256 amount
    ) external onlyRole(WeBlockRoles.TREASURY_FUNDER_ROLE) {
        address vault = _vaultsByAsset[asset].activeVault;
        if (vault == address(0)) {
            revert WeBlockErrors.InvalidVault();
        }

        IERC20(asset).safeTransferFrom(from, vault, amount);
        emit Funded(asset, from, vault, amount);
    }

    function payout(
        address asset,
        address to,
        uint256 amount
    ) external onlyRole(WeBlockRoles.CLAIMS_MANAGER_ROLE) {
        uint256 remaining = amount;
        address[] storage vaults = _vaultsByAsset[asset].vaults;

        for (uint256 i = 0; i < vaults.length && remaining != 0; i++) {
            PaymentVault vault = PaymentVault(vaults[i]);
            uint256 available = IERC20(asset).balanceOf(address(vault));
            if (available == 0) {
                continue;
            }

            uint256 slice = available > remaining ? remaining : available;
            vault.payout(to, slice);
            remaining -= slice;
        }

        if (remaining != 0) {
            revert WeBlockErrors.InsufficientLiquidity();
        }

        emit PaidOut(asset, to, amount);
    }

    function consolidate(
        address asset,
        uint256 maxVaults
    ) external onlyRole(WeBlockRoles.TREASURY_ADMIN_ROLE) {
        address destination = _vaultsByAsset[asset].activeVault;
        if (destination == address(0)) {
            revert WeBlockErrors.InvalidVault();
        }

        address[] storage vaults = _vaultsByAsset[asset].vaults;
        uint256 moved;
        uint256 visited;

        for (uint256 i = 0; i < vaults.length && visited < maxVaults; i++) {
            address source = vaults[i];
            if (source == destination) {
                continue;
            }

            uint256 balance = IERC20(asset).balanceOf(source);
            if (balance == 0) {
                continue;
            }

            PaymentVault(source).sweep(destination, balance);
            emit Consolidated(asset, source, destination, balance);
            moved += balance;
            visited++;
        }

        if (moved == 0) {
            return;
        }
    }

    function _containsVault(
        address asset,
        address vault
    ) private view returns (bool) {
        address[] storage vaults = _vaultsByAsset[asset].vaults;
        for (uint256 i = 0; i < vaults.length; i++) {
            if (vaults[i] == vault) {
                return true;
            }
        }
        return false;
    }
}
