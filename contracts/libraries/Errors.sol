// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Errors
/// @notice Custom errors shared across the WeBlock contract suite (cheaper than require strings).
library Errors {
    error ZeroAddress();
    error ZeroAmount();
    error LengthMismatch();
    error Unauthorized();

    // KYC / transfer gate
    error NotKycVerified(address account);
    error TransferNotAllowed();

    // Series lifecycle
    error SeriesNotFound(uint256 tokenId);
    error SeriesExists(uint256 tokenId);
    error InvalidState();
    error SaleNotActive();
    error SaleStillActive();
    error ExceedsMaxSupply();
    error NotMatured();
    error UnsupportedPayToken(address token);

    // Claims / merkle
    error AlreadyClaimed();
    error InvalidProof();
    error RoundNotFound(uint256 roundId);
    error RoundExists(uint256 roundId);

    // Signatures / orders
    error Expired();
    error BadSignature();
    error NonceUsed();
    error PriceCrossed();
    error ReduceOnlyViolation();
    error SelfTrade();

    // Margin / perp
    error InsufficientMargin();
    error InsufficientFreeEquity();
    error PositionHealthy();
    error LeverageTooHigh();
    error MarketNotFound(uint256 marketId);
    error MarketPaused();

    // Oracle
    error DeviationTooHigh();
    error StalePrice();
    error InvalidPrice();

    // Funds
    error InsufficientBalance();
}
