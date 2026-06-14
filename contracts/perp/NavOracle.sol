// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

/// @title NavOracle
/// @notice Operator-published index/mark price source for RBT perpetual markets.
///         RBT series are illiquid and have no liquid market price, so the index
///         is a NAV (net-asset-value) figure derived off-chain (property appraisal
///         + accrued interest, optionally blended with spot order-book TWAP) and
///         published on-chain by a trusted publisher. This is, by design, a
///         *managed* oracle — the trust model must be disclosed to traders and the
///         publisher key must be a multisig/timelock before mainnet.
/// @dev    Prices are denominated in quote-token base units (USDR, 6 decimals)
///         per 1 RBT contract. A per-update deviation guard and a global staleness
///         window protect consumers (PerpClearing) from fat-finger / stale feeds.
contract NavOracle is AccessControl {
    /// @dev Role allowed to push new prices. Held by the backend NAV publisher.
    bytes32 public constant ORACLE_PUBLISHER_ROLE =
        keccak256("ORACLE_PUBLISHER_ROLE");

    uint256 internal constant BPS = 10_000;

    struct PriceData {
        uint256 price; // quote base units per contract
        uint64 updatedAt; // block timestamp of last update
        bool exists;
    }

    /// @notice marketId (== RBT tokenId) => latest price data.
    mapping(uint256 => PriceData) private _prices;

    /// @notice Max allowed move per single update, in basis points (e.g. 2000 = 20%).
    uint256 public maxDeviationBps;

    /// @notice Reads older than this many seconds are considered stale.
    uint64 public maxStaleness;

    event PricePublished(
        uint256 indexed marketId,
        uint256 price,
        uint64 updatedAt
    );
    event MarketInitialized(uint256 indexed marketId, uint256 price);
    event DeviationGuardUpdated(uint256 maxDeviationBps);
    event StalenessWindowUpdated(uint64 maxStaleness);

    error ZeroAddress();
    error ZeroPrice();
    error MarketUnknown();
    error MarketAlreadyInitialized();
    error DeviationTooLarge();
    error StalePrice();

    constructor(
        address admin,
        address publisher,
        uint256 maxDeviationBps_,
        uint64 maxStaleness_
    ) {
        if (admin == address(0) || publisher == address(0)) {
            revert ZeroAddress();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ORACLE_PUBLISHER_ROLE, publisher);
        maxDeviationBps = maxDeviationBps_;
        maxStaleness = maxStaleness_;
    }

    /// @notice Seed a brand-new market with its first reference price.
    function initializeMarket(
        uint256 marketId,
        uint256 price
    ) external onlyRole(ORACLE_PUBLISHER_ROLE) {
        if (price == 0) revert ZeroPrice();
        if (_prices[marketId].exists) revert MarketAlreadyInitialized();
        _prices[marketId] = PriceData({
            price: price,
            updatedAt: uint64(block.timestamp),
            exists: true
        });
        emit MarketInitialized(marketId, price);
        emit PricePublished(marketId, price, uint64(block.timestamp));
    }

    /// @notice Publish a fresh price for an initialized market, bounded by the
    ///         per-update deviation guard.
    function publishPrice(
        uint256 marketId,
        uint256 price
    ) external onlyRole(ORACLE_PUBLISHER_ROLE) {
        if (price == 0) revert ZeroPrice();
        PriceData storage data = _prices[marketId];
        if (!data.exists) revert MarketUnknown();

        uint256 prev = data.price;
        uint256 diff = price > prev ? price - prev : prev - price;
        if (diff * BPS > prev * maxDeviationBps) revert DeviationTooLarge();

        data.price = price;
        data.updatedAt = uint64(block.timestamp);
        emit PricePublished(marketId, price, uint64(block.timestamp));
    }

    /// @notice Latest price without freshness enforcement.
    function getPrice(
        uint256 marketId
    ) external view returns (uint256 price, uint64 updatedAt) {
        PriceData storage data = _prices[marketId];
        if (!data.exists) revert MarketUnknown();
        return (data.price, data.updatedAt);
    }

    /// @notice Latest price, reverting if older than `maxStaleness`. Used by
    ///         PerpClearing for margin and liquidation maths.
    function getPriceChecked(
        uint256 marketId
    ) external view returns (uint256 price) {
        PriceData storage data = _prices[marketId];
        if (!data.exists) revert MarketUnknown();
        if (block.timestamp > uint256(data.updatedAt) + maxStaleness) {
            revert StalePrice();
        }
        return data.price;
    }

    function hasMarket(uint256 marketId) external view returns (bool) {
        return _prices[marketId].exists;
    }

    function setMaxDeviationBps(
        uint256 maxDeviationBps_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxDeviationBps = maxDeviationBps_;
        emit DeviationGuardUpdated(maxDeviationBps_);
    }

    function setMaxStaleness(
        uint64 maxStaleness_
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxStaleness = maxStaleness_;
        emit StalenessWindowUpdated(maxStaleness_);
    }
}
