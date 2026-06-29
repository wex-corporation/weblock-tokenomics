// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title NavOracle
/// @notice Operator-published NAV mark/index price per perp market (one market per RBT series).
///         RBT is illiquid with no external feed, so the backend computes NAV from the underlying
///         property valuation + accrued interest, then publishes here (KMS-signed; multisig+timelock
///         on mainnet). Guards: per-update deviation cap, monotonic timestamps, staleness window on read.
/// @dev This is the highest-risk component; its trust model (synthetic perp on operator NAV) is
///      disclosed in the UI. Priority-1 for external audit.
contract NavOracle is AccessControl {
    struct Feed {
        uint256 price; // 6dp quote per RBT unit
        uint64 updatedAt;
        bool exists;
    }

    mapping(uint256 => Feed) public feeds; // marketId => Feed
    uint256 public maxDeviationBps; // reject single updates moving more than this (e.g. 2000 = 20%)
    uint64 public maxStalenessSecs; // markPrice() reverts if older than this

    event Published(uint256 indexed marketId, uint256 price, uint64 timestamp);
    event ParamsUpdated(uint256 maxDeviationBps, uint64 maxStalenessSecs);

    constructor(address admin, uint256 maxDeviationBps_, uint64 maxStalenessSecs_) {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.ORACLE_PUBLISHER_ROLE, admin);
        _grantRole(Roles.MARKET_ADMIN_ROLE, admin);
        maxDeviationBps = maxDeviationBps_;
        maxStalenessSecs = maxStalenessSecs_;
    }

    function publish(uint256 marketId, uint256 price, uint64 timestamp) external onlyRole(Roles.ORACLE_PUBLISHER_ROLE) {
        if (price == 0) revert Errors.InvalidPrice();
        Feed storage f = feeds[marketId];
        if (f.exists) {
            if (timestamp <= f.updatedAt) revert Errors.StalePrice(); // monotonic
            uint256 prev = f.price;
            uint256 diff = price > prev ? price - prev : prev - price;
            if (diff * 10_000 > prev * maxDeviationBps) revert Errors.DeviationTooHigh();
        }
        f.price = price;
        f.updatedAt = timestamp;
        f.exists = true;
        emit Published(marketId, price, timestamp);
    }

    /// @notice Current mark price; reverts if missing or stale (circuit breaker).
    function markPrice(uint256 marketId) external view returns (uint256) {
        Feed storage f = feeds[marketId];
        if (!f.exists) revert Errors.InvalidPrice();
        if (block.timestamp > uint256(f.updatedAt) + maxStalenessSecs) revert Errors.StalePrice();
        return f.price;
    }

    function getFeed(uint256 marketId) external view returns (Feed memory) {
        return feeds[marketId];
    }

    function setParams(uint256 maxDeviationBps_, uint64 maxStalenessSecs_) external onlyRole(Roles.MARKET_ADMIN_ROLE) {
        maxDeviationBps = maxDeviationBps_;
        maxStalenessSecs = maxStalenessSecs_;
        emit ParamsUpdated(maxDeviationBps_, maxStalenessSecs_);
    }
}
