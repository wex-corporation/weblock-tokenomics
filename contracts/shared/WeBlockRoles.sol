// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library WeBlockRoles {
    bytes32 internal constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    bytes32 internal constant URI_MANAGER_ROLE = keccak256("URI_MANAGER_ROLE");
    bytes32 internal constant TREASURY_ADMIN_ROLE = keccak256(
        "TREASURY_ADMIN_ROLE"
    );
    bytes32 internal constant TREASURY_FUNDER_ROLE = keccak256(
        "TREASURY_FUNDER_ROLE"
    );
    bytes32 internal constant CLAIMS_MANAGER_ROLE = keccak256(
        "CLAIMS_MANAGER_ROLE"
    );
    bytes32 internal constant DELINQUENCY_MANAGER_ROLE = keccak256(
        "DELINQUENCY_MANAGER_ROLE"
    );
    bytes32 internal constant LOCK_MANAGER_ROLE = keccak256(
        "LOCK_MANAGER_ROLE"
    );
    bytes32 internal constant AIRDROP_ROLE = keccak256("AIRDROP_ROLE");
    bytes32 internal constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 internal constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
}
