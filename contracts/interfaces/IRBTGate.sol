// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IRBTGate
/// @notice Secondary-transfer gate consulted by the RBT token on every non-mint/non-burn move.
///         Implemented by SeriesManager: enforces KYC on both parties and series-state rules.
interface IRBTGate {
    /// @dev MUST revert if the transfer is not allowed.
    function checkTransfer(address operator, address from, address to, uint256 id, uint256 value)
        external
        view;
}
