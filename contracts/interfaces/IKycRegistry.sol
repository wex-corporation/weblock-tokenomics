// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IKycRegistry
/// @notice Minimal read interface for the on-chain KYC allowlist.
interface IKycRegistry {
    function isVerified(address account) external view returns (bool);
}
