// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Roles
/// @notice Shared role identifiers for the WeBlock contract suite. Each contract uses
///         OpenZeppelin AccessControl with the subset of roles it needs.
library Roles {
    // Generic ops
    bytes32 internal constant OPERATOR_ROLE = keccak256("WEBLOCK_OPERATOR");
    bytes32 internal constant PAUSER_ROLE = keccak256("WEBLOCK_PAUSER");

    // Tokens
    bytes32 internal constant MANAGER_ROLE = keccak256("WEBLOCK_MANAGER"); // RBT mint/burn (SeriesManager)
    bytes32 internal constant MINTER_ROLE = keccak256("WEBLOCK_MINTER"); // USDR / WFT mint
    bytes32 internal constant URI_MANAGER_ROLE = keccak256("WEBLOCK_URI_MANAGER");
    bytes32 internal constant LOCK_MANAGER_ROLE = keccak256("WEBLOCK_LOCK_MANAGER");

    // KYC
    bytes32 internal constant KYC_MANAGER_ROLE = keccak256("WEBLOCK_KYC_MANAGER");

    // RWA / treasury
    bytes32 internal constant TREASURY_FUNDER_ROLE = keccak256("WEBLOCK_TREASURY_FUNDER");
    bytes32 internal constant TREASURY_ADMIN_ROLE = keccak256("WEBLOCK_TREASURY_ADMIN");
    bytes32 internal constant DELINQUENCY_MANAGER_ROLE = keccak256("WEBLOCK_DELINQUENCY_MANAGER");
    bytes32 internal constant DISTRIBUTION_MANAGER_ROLE = keccak256("WEBLOCK_DISTRIBUTION_MANAGER");

    // Markets / perp
    bytes32 internal constant SETTLEMENT_ROLE = keccak256("WEBLOCK_SETTLEMENT");
    bytes32 internal constant FUNDING_ROLE = keccak256("WEBLOCK_FUNDING");
    bytes32 internal constant LIQUIDATOR_ROLE = keccak256("WEBLOCK_LIQUIDATOR");
    bytes32 internal constant MARKET_ADMIN_ROLE = keccak256("WEBLOCK_MARKET_ADMIN");
    bytes32 internal constant ORACLE_PUBLISHER_ROLE = keccak256("WEBLOCK_ORACLE_PUBLISHER");
    bytes32 internal constant DRAWER_ROLE = keccak256("WEBLOCK_DRAWER");
}
