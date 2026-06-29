// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";
import {IKycRegistry} from "../interfaces/IKycRegistry.sol";

/// @title KycRegistry
/// @notice On-chain allowlist of KYC-verified wallets, maintained by the WeBlock backend KYC service.
///         The RBT transfer gate and SeriesManager.buy consult this before moving/minting RBT.
contract KycRegistry is AccessControl, IKycRegistry {
    mapping(address => bool) private _verified;

    event KycSet(address indexed account, bool verified);

    constructor(address admin) {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.KYC_MANAGER_ROLE, admin);
    }

    function isVerified(address account) external view returns (bool) {
        return _verified[account];
    }

    function setVerified(address account, bool verified) external onlyRole(Roles.KYC_MANAGER_ROLE) {
        _verified[account] = verified;
        emit KycSet(account, verified);
    }

    function setVerifiedBatch(address[] calldata accounts, bool verified)
        external
        onlyRole(Roles.KYC_MANAGER_ROLE)
    {
        for (uint256 i; i < accounts.length; ++i) {
            _verified[accounts[i]] = verified;
            emit KycSet(accounts[i], verified);
        }
    }
}
