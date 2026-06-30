// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";
import {INavOracle} from "../interfaces/INavOracle.sol";
import {IInsuranceFund} from "../interfaces/IInsuranceFund.sol";

/// @title PerpClearing
/// @notice Non-custodial, cash-settled (USDR) perpetual-futures clearing for RBT markets.
///         Off-chain matched (EIP-712 signed orders), on-chain settled. Isolated margin.
///         The non-custodial invariant: only a trader can withdraw their own free collateral;
///         the settlement operator can only move balances within match/funding/liquidation rules.
/// @dev PRE-AUDIT, TESTNET V1. Simplifications (documented): isolated margin only, no single-fill
///      position flips, pool-balanced approximate funding, mark-price liquidation. External audit
///      mandatory before mainnet. Margin/PnL are in USDR base units (6dp); size in RBT units;
///      price is USDR(6dp) per RBT unit.
contract PerpClearing is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    int256 private constant FUNDING_SCALE = 1e18;

    struct Market {
        bool exists;
        bool paused;
        uint256 initialMarginBps; // floor margin on opens (e.g. 2000 = 5x max)
        uint256 maintenanceMarginBps; // liquidation threshold (e.g. 1000)
        uint256 takerFeeBps;
        uint256 makerFeeBps;
        uint256 liquidationFeeBps;
        int256 cumFundingIndex; // accumulated funding (scaled 1e18, USDR-per-unit)
    }

    struct Position {
        int256 size; // signed RBT units (>0 long, <0 short)
        uint256 entryPrice; // avg entry, USDR 6dp per unit
        uint256 margin; // USDR base units locked
        int256 fundingSnapshot; // cumFundingIndex at last touch
    }

    struct Order {
        address trader;
        uint256 marketId;
        bool isBuy;
        uint256 price;
        uint256 amount;
        uint256 marginBps;
        uint256 nonce;
        uint256 expiry;
        bool reduceOnly;
    }

    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 marginBps,uint256 nonce,uint256 expiry,bool reduceOnly)"
    );

    IERC20 public immutable usdr;
    INavOracle public immutable oracle;
    IInsuranceFund public insurance;

    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => Position)) public positions; // marketId => trader => Position
    mapping(address => uint256) public freeCollateral; // trader => withdrawable USDR
    mapping(bytes32 => uint256) public filled; // orderHash => filled amount
    mapping(address => mapping(uint256 => bool)) public nonceInvalidated;

    uint256 public protocolFees;
    uint256 public collectedFunding; // pool of funding paid in, disbursed to receivers
    /// @notice Max allowed deviation of a settlement fill price from the fresh oracle mark (H-1).
    ///         Blocks a manipulated/operator-chosen fill price from manufacturing PnL whenever the
    ///         oracle is live. 0 disables the band (falls back to signed-limit bounds only).
    uint256 public maxFillDeviationBps = 1000; // 10%
    /// @notice Cumulative bad debt the insurance fund could NOT cover (H-2). Surfaced for ops;
    ///         grows only when InsuranceFund is underfunded during a loss/liquidation.
    uint256 public totalUnbackedDebt;

    event UnbackedDebt(uint256 indexed marketId, address indexed trader, uint256 amount, uint256 cumulative);

    event MarketCreated(uint256 indexed marketId);
    event Deposit(address indexed trader, uint256 amount);
    event Withdraw(address indexed trader, uint256 amount);
    event TradeSettled(uint256 indexed marketId, address indexed maker, address indexed taker, uint256 price, uint256 amount);
    event FundingApplied(uint256 indexed marketId, int256 deltaScaled, int256 cumFundingIndex);
    event Liquidated(uint256 indexed marketId, address indexed trader, uint256 mark, int256 equity);
    event NonceInvalidated(address indexed trader, uint256 nonce);

    constructor(address admin, address usdr_, address oracle_, address insurance_) EIP712("WeBlockPerp", "1") {
        if (admin == address(0) || usdr_ == address(0) || oracle_ == address(0) || insurance_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        usdr = IERC20(usdr_);
        oracle = INavOracle(oracle_);
        insurance = IInsuranceFund(insurance_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.SETTLEMENT_ROLE, admin);
        _grantRole(Roles.FUNDING_ROLE, admin);
        _grantRole(Roles.LIQUIDATOR_ROLE, admin);
        _grantRole(Roles.MARKET_ADMIN_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, admin);
    }

    // ------------------------------------------------------------- collateral
    function deposit(uint256 amount) external nonReentrant whenNotPaused {
        if (amount == 0) revert Errors.ZeroAmount();
        usdr.safeTransferFrom(msg.sender, address(this), amount);
        freeCollateral[msg.sender] += amount;
        emit Deposit(msg.sender, amount);
    }

    /// @notice Withdraw free collateral. Only the owner can call; only free (unlocked) equity moves.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert Errors.ZeroAmount();
        if (freeCollateral[msg.sender] < amount) revert Errors.InsufficientFreeEquity();
        freeCollateral[msg.sender] -= amount;
        usdr.safeTransfer(msg.sender, amount);
        emit Withdraw(msg.sender, amount);
    }

    // ------------------------------------------------------------- markets
    function createMarket(
        uint256 marketId,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 takerFeeBps,
        uint256 makerFeeBps,
        uint256 liquidationFeeBps
    ) external onlyRole(Roles.MARKET_ADMIN_ROLE) {
        if (markets[marketId].exists) revert Errors.InvalidState();
        if (maintenanceMarginBps >= initialMarginBps || initialMarginBps > BPS) revert Errors.InvalidState();
        markets[marketId] = Market(
            true, false, initialMarginBps, maintenanceMarginBps, takerFeeBps, makerFeeBps, liquidationFeeBps, 0
        );
        emit MarketCreated(marketId);
    }

    function setMarketPaused(uint256 marketId, bool paused_) external onlyRole(Roles.MARKET_ADMIN_ROLE) {
        markets[marketId].paused = paused_;
    }

    /// @notice Set the settlement fill-price oracle band (bps). 0 disables it. (H-1)
    function setMaxFillDeviationBps(uint256 bps) external onlyRole(Roles.MARKET_ADMIN_ROLE) {
        if (bps > BPS) revert Errors.InvalidState();
        maxFillDeviationBps = bps;
    }

    // ------------------------------------------------------------- funding
    function applyFunding(uint256 marketId, int256 deltaScaled) external onlyRole(Roles.FUNDING_ROLE) {
        Market storage m = markets[marketId];
        if (!m.exists) revert Errors.MarketNotFound(marketId);
        m.cumFundingIndex += deltaScaled;
        emit FundingApplied(marketId, deltaScaled, m.cumFundingIndex);
    }

    function _settleFunding(uint256 marketId, address trader) internal {
        Market storage m = markets[marketId];
        Position storage p = positions[marketId][trader];
        if (p.size != 0) {
            int256 delta = m.cumFundingIndex - p.fundingSnapshot;
            if (delta != 0) {
                int256 payment = (p.size * delta) / FUNDING_SCALE; // >0 trader pays
                if (payment > 0) {
                    uint256 pay = uint256(payment);
                    uint256 fromMargin = pay > p.margin ? p.margin : pay;
                    p.margin -= fromMargin;
                    collectedFunding += fromMargin;
                } else {
                    uint256 recv = uint256(-payment);
                    uint256 give = recv > collectedFunding ? collectedFunding : recv;
                    collectedFunding -= give;
                    p.margin += give;
                }
            }
        }
        p.fundingSnapshot = m.cumFundingIndex;
    }

    // ------------------------------------------------------------- settlement
    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH, o.trader, o.marketId, o.isBuy, o.price, o.amount, o.marginBps, o.nonce, o.expiry, o.reduceOnly
                )
            )
        );
    }

    function _verify(Order calldata o, bytes calldata sig) internal view returns (bytes32 h) {
        h = hashOrder(o);
        if (ECDSA.recover(h, sig) != o.trader) revert Errors.BadSignature();
        if (block.timestamp > o.expiry) revert Errors.Expired();
        if (nonceInvalidated[o.trader][o.nonce]) revert Errors.NonceUsed();
    }

    function settleTrades(
        Order calldata maker,
        bytes calldata makerSig,
        Order calldata taker,
        bytes calldata takerSig,
        uint256 fillAmount,
        uint256 fillPrice
    ) external onlyRole(Roles.SETTLEMENT_ROLE) nonReentrant whenNotPaused {
        Market storage m = markets[maker.marketId];
        if (!m.exists) revert Errors.MarketNotFound(maker.marketId);
        if (m.paused) revert Errors.MarketPaused();
        if (maker.marketId != taker.marketId) revert Errors.InvalidState();
        if (maker.isBuy == taker.isBuy) revert Errors.InvalidState();
        if (fillAmount == 0) revert Errors.ZeroAmount();
        if (maker.trader == taker.trader) revert Errors.SelfTrade();
        // price band: buyer.price >= fillPrice >= seller.price
        (uint256 buyPrice, uint256 sellPrice) = maker.isBuy ? (maker.price, taker.price) : (taker.price, maker.price);
        if (fillPrice > buyPrice || fillPrice < sellPrice) revert Errors.PriceCrossed();
        // Oracle band (H-1): whenever the mark is fresh, the fill price must be within
        // maxFillDeviationBps of it — so a manipulated/operator-chosen fill price cannot
        // manufacture PnL out of the shared collateral pool. (Falls back to signed-limit
        // bounds only when the oracle is stale/unset, to avoid a settlement DoS.)
        if (maxFillDeviationBps != 0) {
            (uint256 mark, bool fresh) = oracle.peekPrice(maker.marketId);
            if (fresh && mark > 0) {
                uint256 d = fillPrice > mark ? fillPrice - mark : mark - fillPrice;
                if (d * 10_000 > mark * maxFillDeviationBps) revert Errors.PriceCrossed();
            }
        }

        bytes32 makerHash = _verify(maker, makerSig);
        bytes32 takerHash = _verify(taker, takerSig);
        if (filled[makerHash] + fillAmount > maker.amount) revert Errors.ExceedsMaxSupply();
        if (filled[takerHash] + fillAmount > taker.amount) revert Errors.ExceedsMaxSupply();
        filled[makerHash] += fillAmount;
        filled[takerHash] += fillAmount;

        _applyFill(maker.marketId, maker.trader, maker.isBuy, fillAmount, fillPrice, maker.marginBps, maker.reduceOnly, m.makerFeeBps);
        _applyFill(taker.marketId, taker.trader, taker.isBuy, fillAmount, fillPrice, taker.marginBps, taker.reduceOnly, m.takerFeeBps);

        emit TradeSettled(maker.marketId, maker.trader, taker.trader, fillPrice, fillAmount);
    }

    function _applyFill(
        uint256 marketId,
        address trader,
        bool isBuy,
        uint256 amount,
        uint256 price,
        uint256 marginBps,
        bool reduceOnly,
        uint256 feeBps
    ) internal {
        _settleFunding(marketId, trader);
        Market storage m = markets[marketId];
        Position storage p = positions[marketId][trader];

        int256 delta = isBuy ? int256(amount) : -int256(amount);
        int256 oldSize = p.size;
        int256 newSize = oldSize + delta;
        // no single-fill flips
        if (oldSize != 0 && newSize != 0 && (oldSize > 0) != (newSize > 0)) revert Errors.ReduceOnlyViolation();

        uint256 notional = amount * price;
        uint256 fee = (notional * feeBps) / BPS;
        bool increasing = oldSize == 0 || ((oldSize > 0) == (delta > 0));

        if (increasing) {
            if (reduceOnly) revert Errors.ReduceOnlyViolation();
            if (marginBps < m.initialMarginBps) revert Errors.InsufficientMargin();
            uint256 marginAdd = (notional * marginBps) / BPS;
            uint256 need = marginAdd + fee;
            if (freeCollateral[trader] < need) revert Errors.InsufficientFreeEquity();
            freeCollateral[trader] -= need;
            protocolFees += fee;
            uint256 absOld = oldSize >= 0 ? uint256(oldSize) : uint256(-oldSize);
            p.entryPrice = (absOld * p.entryPrice + amount * price) / (absOld + amount);
            p.margin += marginAdd;
            p.size = newSize;
        } else {
            // reducing/closing `amount` (<= |oldSize|, no-flip guaranteed)
            uint256 absOld = oldSize >= 0 ? uint256(oldSize) : uint256(-oldSize);
            bool wasLong = oldSize > 0;
            int256 pnl = wasLong
                ? (int256(price) - int256(p.entryPrice)) * int256(amount)
                : (int256(p.entryPrice) - int256(price)) * int256(amount);
            uint256 releaseMargin = (p.margin * amount) / absOld;
            p.margin -= releaseMargin;

            // fee: prefer free collateral, else from released margin
            if (freeCollateral[trader] >= fee) {
                freeCollateral[trader] -= fee;
                protocolFees += fee;
            } else if (releaseMargin >= fee) {
                releaseMargin -= fee;
                protocolFees += fee;
            } else {
                protocolFees += releaseMargin;
                releaseMargin = 0;
            }

            int256 ret = int256(releaseMargin) + pnl;
            if (ret >= 0) {
                freeCollateral[trader] += uint256(ret);
            } else {
                uint256 loss = uint256(-ret);
                uint256 fromMargin = loss > p.margin ? p.margin : loss;
                p.margin -= fromMargin;
                uint256 badDebt = loss - fromMargin;
                if (badDebt > 0) _coverBadDebt(marketId, trader, badDebt);
            }
            p.size = newSize;
            if (newSize == 0) {
                if (p.margin > 0) {
                    freeCollateral[trader] += p.margin;
                    p.margin = 0;
                }
                p.entryPrice = 0;
            }
        }
    }

    // ------------------------------------------------------------- liquidation
    function liquidate(uint256 marketId, address trader) external onlyRole(Roles.LIQUIDATOR_ROLE) nonReentrant {
        _settleFunding(marketId, trader);
        Market storage m = markets[marketId];
        Position storage p = positions[marketId][trader];
        if (p.size == 0) revert Errors.InvalidState();

        uint256 mark = oracle.markPrice(marketId);
        uint256 absSize = p.size >= 0 ? uint256(p.size) : uint256(-p.size);
        int256 pnl = p.size > 0
            ? (int256(mark) - int256(p.entryPrice)) * int256(absSize)
            : (int256(p.entryPrice) - int256(mark)) * int256(absSize);
        int256 equity = int256(p.margin) + pnl;
        uint256 notional = absSize * mark;
        uint256 maintenance = (notional * m.maintenanceMarginBps) / BPS;
        if (equity >= int256(maintenance)) revert Errors.PositionHealthy();

        uint256 penalty = (notional * m.liquidationFeeBps) / BPS;
        if (equity > 0) {
            uint256 eq = uint256(equity);
            uint256 pen = penalty > eq ? eq : penalty;
            // penalty to insurance, remainder back to trader's free collateral
            usdr.safeTransfer(address(insurance), pen);
            uint256 remainder = eq - pen;
            if (remainder > 0) freeCollateral[trader] += remainder;
        } else {
            _coverBadDebt(marketId, trader, uint256(-equity));
        }
        delete positions[marketId][trader];
        emit Liquidated(marketId, trader, mark, equity);
    }

    /// @dev Draw bad debt from the insurance fund and record any uncovered shortfall (H-2).
    function _coverBadDebt(uint256 marketId, address trader, uint256 badDebt) internal {
        uint256 paid = insurance.cover(address(this), badDebt);
        if (paid < badDebt) {
            uint256 shortfall = badDebt - paid;
            totalUnbackedDebt += shortfall;
            emit UnbackedDebt(marketId, trader, shortfall, totalUnbackedDebt);
        }
    }

    // ------------------------------------------------------------- views / admin
    function getPosition(uint256 marketId, address trader) external view returns (Position memory) {
        return positions[marketId][trader];
    }

    /// @notice Account equity for a market at current mark (margin + unrealized PnL). View only.
    function positionEquity(uint256 marketId, address trader) external view returns (int256) {
        Position storage p = positions[marketId][trader];
        if (p.size == 0) return int256(p.margin);
        uint256 mark = INavOracle(oracle).markPrice(marketId);
        uint256 absSize = p.size >= 0 ? uint256(p.size) : uint256(-p.size);
        int256 pnl = p.size > 0
            ? (int256(mark) - int256(p.entryPrice)) * int256(absSize)
            : (int256(p.entryPrice) - int256(mark)) * int256(absSize);
        return int256(p.margin) + pnl;
    }

    function invalidateNonce(uint256 nonce) external {
        nonceInvalidated[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    function setInsuranceFund(address insurance_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (insurance_ == address(0)) revert Errors.ZeroAddress();
        insurance = IInsuranceFund(insurance_);
    }

    function withdrawProtocolFees(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (amount > protocolFees) revert Errors.InsufficientBalance();
        protocolFees -= amount;
        usdr.safeTransfer(to, amount);
    }

    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PAUSER_ROLE) {
        _unpause();
    }
}
