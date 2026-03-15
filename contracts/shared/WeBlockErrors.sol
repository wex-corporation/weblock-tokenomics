// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

library WeBlockErrors {
    error ZeroAddress();
    error InvalidArrayLength();
    error UnsupportedPaymentToken();
    error UnsupportedSeriesState();
    error SaleNotOpen();
    error SaleWindowInvalid();
    error SaleNotEnded();
    error MaturityNotReached();
    error SeriesAlreadyExists();
    error SeriesNotFound();
    error QuantityTooLow();
    error QuantityTooHigh();
    error PriceSlippage();
    error TransferNotAllowed();
    error ClaimNothingDue();
    error InsufficientLiquidity();
    error RedemptionNotEnabled();
    error RefundNotAvailable();
    error InsufficientUnlockedBalance();
    error LockNotReady();
    error InvalidVault();
    error InvalidStateTransition();
    error OrderExpired();
    error OrderClosed();
    error UnauthorizedCaller();
}
