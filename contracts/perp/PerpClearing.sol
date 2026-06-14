// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";
import {NavOracle} from "./NavOracle.sol";
import {InsuranceFund} from "./InsuranceFund.sol";

/// @title PerpClearing
/// @notice On-chain settlement & margin core for WeBlock's RBT perpetual-futures
///         exchange. Hybrid design: orders are matched OFF-CHAIN by the backend
///         engine; this contract is the non-custodial settlement layer that
///         custodies collateral, verifies EIP-712-signed orders, books positions,
///         applies funding, and runs liquidations.
///
/// Non-custodial guarantees:
///  - A trader's *free* collateral is withdrawable only by the trader.
///  - The settlement operator can only move balances by submitting fills that are
///    backed by the trader's own EIP-712 signature, within the order's limits.
///  - The operator can never transfer collateral to itself.
///
/// Accounting model (V1, isolated margin, cash-settled in the quote token / USDR):
///  - Everything is denominated in quote-token base units; ratios are basis points.
///  - Each (trader, marketId) position holds its own isolated margin. Mark price
///    comes from {NavOracle}; PnL is unrealised at mark, realised at fill price.
///  - Aggregate solvency holds because every fill creates equal & opposite size
///    (longs == shorts per market), so PnL nets to zero; gap losses beyond a
///    position's margin are absorbed by {InsuranceFund}.
///
/// @dev PRE-AUDIT. This is a testnet V1: no cross-margin, single-fill position
///      flips are disallowed, funding nets through an internal pool. A full
///      external audit is mandatory before mainnet (see scope doc §7).
contract PerpClearing is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    /// @dev Backend engine that submits matched fills.
    bytes32 public constant SETTLEMENT_ROLE = keccak256("SETTLEMENT_ROLE");
    /// @dev Keeper allowed to trigger liquidations.
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    /// @dev Funding-rate publisher (the backend funding scheduler).
    bytes32 public constant FUNDING_ROLE = keccak256("FUNDING_ROLE");
    /// @dev Market parameter administrator.
    bytes32 public constant MARKET_ADMIN_ROLE = keccak256("MARKET_ADMIN_ROLE");

    uint256 internal constant BPS = 10_000;
    int256 internal constant FUNDING_SCALE = 1e18;

    bytes32 private constant ORDER_TYPEHASH =
        keccak256(
            "Order(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 marginBps,uint256 nonce,uint256 expiry,bool reduceOnly)"
        );

    struct Order {
        address trader;
        uint256 marketId;
        bool isBuy;
        uint256 price; // limit price (quote units/contract): buy=max, sell=min
        uint256 amount; // total contracts the order may fill
        uint256 marginBps; // requested initial margin in bps (>= market.initialMarginBps)
        uint256 nonce;
        uint256 expiry; // unix seconds; fill must be <= expiry
        bool reduceOnly;
    }

    struct Trade {
        Order maker;
        bytes makerSig;
        Order taker;
        bytes takerSig;
        uint256 fillAmount;
        uint256 fillPrice;
    }

    struct Market {
        bool exists;
        bool active;
        uint256 initialMarginBps; // e.g. 2000 (=> 5x max leverage)
        uint256 maintenanceMarginBps; // e.g. 1000
        uint256 makerFeeBps;
        uint256 takerFeeBps;
        uint256 liquidationFeeBps;
    }

    struct Position {
        int256 size; // +long / -short, in contracts
        uint256 avgEntryPrice; // quote units/contract
        uint256 margin; // isolated margin, quote units
        int256 entryFundingIndex; // funding index snapshot
    }

    IERC20 public immutable quoteToken;
    NavOracle public immutable oracle;
    InsuranceFund public immutable insuranceFund;

    /// @notice Free (withdrawable) collateral per trader.
    mapping(address => uint256) public balanceOf;
    /// @notice positions[trader][marketId].
    mapping(address => mapping(uint256 => Position)) private _positions;
    /// @notice marketId => market config.
    mapping(uint256 => Market) public markets;
    /// @notice marketId => cumulative funding index (scaled by FUNDING_SCALE).
    mapping(uint256 => int256) public cumulativeFundingIndex;
    /// @notice EIP-712 order digest => cumulative filled amount.
    mapping(bytes32 => uint256) public filledAmount;
    /// @notice EIP-712 order digest => cancelled flag.
    mapping(bytes32 => bool) public cancelledOrder;

    /// @notice Internal funding pool: collected from payers, paid to receivers.
    ///         Signed and order-independent within a batch; nets to ~0 when the
    ///         operator sets funding so that long and short notional balance.
    int256 public fundingPool;
    /// @notice Accrued protocol fees + liquidation penalties (admin-withdrawable).
    uint256 public protocolFees;

    event Deposited(address indexed trader, uint256 amount);
    event Withdrawn(address indexed trader, uint256 amount);
    event MarketAdded(uint256 indexed marketId);
    event MarketParamsUpdated(uint256 indexed marketId);
    event MarketActiveSet(uint256 indexed marketId, bool active);
    event FundingUpdated(uint256 indexed marketId, int256 deltaIndex, int256 newIndex);
    event OrderCancelled(address indexed trader, bytes32 indexed orderDigest);
    event TradeSettled(
        uint256 indexed marketId,
        address indexed maker,
        address indexed taker,
        uint256 fillAmount,
        uint256 fillPrice
    );
    event PositionChanged(
        address indexed trader,
        uint256 indexed marketId,
        int256 newSize,
        uint256 avgEntryPrice,
        uint256 margin
    );
    event Liquidated(
        address indexed trader,
        uint256 indexed marketId,
        uint256 markPrice,
        uint256 penalty
    );
    event BadDebt(address indexed trader, uint256 indexed marketId, uint256 uncoveredAmount);
    event FeesWithdrawn(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InsufficientCollateral();
    error MarketExists();
    error UnknownMarket();
    error MarketInactive();
    error InvalidMarginParams();
    error SidesNotOpposite();
    error MarketMismatch();
    error BadSignature();
    error OrderIsCancelled();
    error OrderExpired();
    error PriceOutOfBounds();
    error Overfill();
    error LeverageTooHigh();
    error ReduceOnlyViolation();
    error PositionFlipNotAllowed();
    error NoPosition();
    error NotLiquidatable();
    error InitialMarginUnmet();
    error NotOrderOwner();

    constructor(
        address admin,
        address quoteToken_,
        address oracle_,
        address insuranceFund_,
        address settlementOperator
    ) EIP712("WeBlockPerp", "1") {
        if (
            admin == address(0) ||
            quoteToken_ == address(0) ||
            oracle_ == address(0) ||
            insuranceFund_ == address(0) ||
            settlementOperator == address(0)
        ) {
            revert ZeroAddress();
        }
        quoteToken = IERC20(quoteToken_);
        oracle = NavOracle(oracle_);
        insuranceFund = InsuranceFund(insuranceFund_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MARKET_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.PAUSER_ROLE, admin);
        _grantRole(SETTLEMENT_ROLE, settlementOperator);
        _grantRole(LIQUIDATOR_ROLE, settlementOperator);
        _grantRole(FUNDING_ROLE, settlementOperator);
    }

    // --------------------------------------------------------------------- //
    //                              Collateral                               //
    // --------------------------------------------------------------------- //

    /// @notice Deposit quote-token collateral. Caller must have approved `amount`.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        quoteToken.safeTransferFrom(msg.sender, address(this), amount);
        balanceOf[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw free collateral. Margin locked in positions is excluded,
    ///         so this is always safe for the trader's solvency.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientCollateral();
        balanceOf[msg.sender] = bal - amount;
        quoteToken.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // --------------------------------------------------------------------- //
    //                          Market administration                        //
    // --------------------------------------------------------------------- //

    function addMarket(
        uint256 marketId,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 makerFeeBps,
        uint256 takerFeeBps,
        uint256 liquidationFeeBps
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        if (markets[marketId].exists) revert MarketExists();
        _validateMarginParams(initialMarginBps, maintenanceMarginBps);
        markets[marketId] = Market({
            exists: true,
            active: true,
            initialMarginBps: initialMarginBps,
            maintenanceMarginBps: maintenanceMarginBps,
            makerFeeBps: makerFeeBps,
            takerFeeBps: takerFeeBps,
            liquidationFeeBps: liquidationFeeBps
        });
        emit MarketAdded(marketId);
    }

    function setMarketParams(
        uint256 marketId,
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps,
        uint256 makerFeeBps,
        uint256 takerFeeBps,
        uint256 liquidationFeeBps
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        Market storage m = markets[marketId];
        if (!m.exists) revert UnknownMarket();
        _validateMarginParams(initialMarginBps, maintenanceMarginBps);
        m.initialMarginBps = initialMarginBps;
        m.maintenanceMarginBps = maintenanceMarginBps;
        m.makerFeeBps = makerFeeBps;
        m.takerFeeBps = takerFeeBps;
        m.liquidationFeeBps = liquidationFeeBps;
        emit MarketParamsUpdated(marketId);
    }

    function setMarketActive(
        uint256 marketId,
        bool active
    ) external onlyRole(MARKET_ADMIN_ROLE) {
        Market storage m = markets[marketId];
        if (!m.exists) revert UnknownMarket();
        m.active = active;
        emit MarketActiveSet(marketId, active);
    }

    function _validateMarginParams(
        uint256 initialMarginBps,
        uint256 maintenanceMarginBps
    ) internal pure {
        // maintenance must be > 0 and strictly below initial; initial <= 100%.
        if (
            maintenanceMarginBps == 0 ||
            maintenanceMarginBps >= initialMarginBps ||
            initialMarginBps > BPS
        ) {
            revert InvalidMarginParams();
        }
    }

    // --------------------------------------------------------------------- //
    //                                Funding                                //
    // --------------------------------------------------------------------- //

    /// @notice Advance a market's cumulative funding index. `deltaIndexScaled` is
    ///         quote-units-per-contract * FUNDING_SCALE; positive => longs pay
    ///         shorts. Set off-chain so net funding ≈ 0 across the book.
    function pokeFunding(
        uint256 marketId,
        int256 deltaIndexScaled
    ) external onlyRole(FUNDING_ROLE) {
        if (!markets[marketId].exists) revert UnknownMarket();
        int256 newIndex = cumulativeFundingIndex[marketId] + deltaIndexScaled;
        cumulativeFundingIndex[marketId] = newIndex;
        emit FundingUpdated(marketId, deltaIndexScaled, newIndex);
    }

    // --------------------------------------------------------------------- //
    //                          Orders / settlement                          //
    // --------------------------------------------------------------------- //

    /// @notice Cancel one of your own resting orders (off-chain engine should
    ///         honour this too; on-chain flag is the backstop).
    function cancelOrder(Order calldata order) external {
        if (order.trader != msg.sender) revert NotOrderOwner();
        bytes32 digest = _orderDigest(order);
        cancelledOrder[digest] = true;
        emit OrderCancelled(msg.sender, digest);
    }

    /// @notice Settle a batch of off-chain-matched trades.
    function settleTrades(
        Trade[] calldata trades
    ) external nonReentrant whenNotPaused onlyRole(SETTLEMENT_ROLE) {
        for (uint256 i = 0; i < trades.length; i++) {
            _settleTrade(trades[i]);
        }
    }

    function _settleTrade(Trade calldata t) internal {
        Order calldata maker = t.maker;
        Order calldata taker = t.taker;

        if (maker.marketId != taker.marketId) revert MarketMismatch();
        if (maker.isBuy == taker.isBuy) revert SidesNotOpposite();

        Market storage m = markets[maker.marketId];
        if (!m.exists) revert UnknownMarket();
        if (!m.active) revert MarketInactive();

        bytes32 makerDigest = _verify(maker, t.makerSig);
        bytes32 takerDigest = _verify(taker, t.takerSig);

        _checkFillBounds(maker, makerDigest, t.fillAmount, t.fillPrice);
        _checkFillBounds(taker, takerDigest, t.fillAmount, t.fillPrice);

        filledAmount[makerDigest] += t.fillAmount;
        filledAmount[takerDigest] += t.fillAmount;

        _applyFill(
            maker.trader,
            maker.marketId,
            maker.isBuy ? int256(t.fillAmount) : -int256(t.fillAmount),
            t.fillPrice,
            maker.marginBps,
            m.makerFeeBps,
            maker.reduceOnly
        );
        _applyFill(
            taker.trader,
            taker.marketId,
            taker.isBuy ? int256(t.fillAmount) : -int256(t.fillAmount),
            t.fillPrice,
            taker.marginBps,
            m.takerFeeBps,
            taker.reduceOnly
        );

        emit TradeSettled(
            maker.marketId,
            maker.trader,
            taker.trader,
            t.fillAmount,
            t.fillPrice
        );
    }

    function _verify(
        Order calldata order,
        bytes calldata sig
    ) internal view returns (bytes32 digest) {
        digest = _orderDigest(order);
        if (cancelledOrder[digest]) revert OrderIsCancelled();
        if (block.timestamp > order.expiry) revert OrderExpired();
        address signer = ECDSA.recover(digest, sig);
        if (signer != order.trader) revert BadSignature();
    }

    function _checkFillBounds(
        Order calldata order,
        bytes32 digest,
        uint256 fillAmount,
        uint256 fillPrice
    ) internal view {
        if (fillAmount == 0) revert ZeroAmount();
        if (order.isBuy) {
            if (fillPrice > order.price) revert PriceOutOfBounds();
        } else {
            if (fillPrice < order.price) revert PriceOutOfBounds();
        }
        if (filledAmount[digest] + fillAmount > order.amount) revert Overfill();
    }

    /// @dev Core position mutation for a single side of a fill.
    function _applyFill(
        address trader,
        uint256 marketId,
        int256 signedQty,
        uint256 fillPrice,
        uint256 orderMarginBps,
        uint256 feeBps,
        bool reduceOnly
    ) internal {
        Position storage pos = _positions[trader][marketId];
        _settleFunding(pos, marketId);

        int256 curSize = pos.size;
        bool increasing = (curSize == 0 || _sameSign(curSize, signedQty));
        if (increasing) {
            if (reduceOnly) revert ReduceOnlyViolation();
            _increasePosition(trader, pos, marketId, signedQty, fillPrice, orderMarginBps);
        } else {
            _reducePosition(trader, pos, marketId, signedQty, fillPrice);
        }

        _chargeFee(trader, _abs(signedQty), fillPrice, feeBps);

        // opening/increasing must leave the position at/above initial margin (mark)
        if (pos.size != 0 && increasing) {
            _requireInitialMargin(pos, marketId);
        }

        emit PositionChanged(
            trader,
            marketId,
            pos.size,
            pos.avgEntryPrice,
            pos.margin
        );
    }

    function _increasePosition(
        address trader,
        Position storage pos,
        uint256 marketId,
        int256 signedQty,
        uint256 fillPrice,
        uint256 orderMarginBps
    ) internal {
        if (orderMarginBps < markets[marketId].initialMarginBps) {
            revert LeverageTooHigh();
        }
        uint256 absQty = _abs(signedQty);
        uint256 addMargin = (absQty * fillPrice * orderMarginBps) / BPS;
        _lockMargin(trader, pos, addMargin);

        int256 curSize = pos.size;
        if (curSize == 0) {
            pos.avgEntryPrice = fillPrice;
        } else {
            uint256 curAbs = _abs(curSize);
            pos.avgEntryPrice =
                (pos.avgEntryPrice * curAbs + fillPrice * absQty) /
                (curAbs + absQty);
        }
        pos.size = curSize + signedQty;
    }

    function _reducePosition(
        address trader,
        Position storage pos,
        uint256 marketId,
        int256 signedQty,
        uint256 fillPrice
    ) internal {
        int256 curSize = pos.size;
        uint256 curAbs = _abs(curSize);
        uint256 absQty = _abs(signedQty);
        if (absQty > curAbs) revert PositionFlipNotAllowed();

        int256 pnl = curSize > 0
            ? int256(absQty) *
                (SafeCast.toInt256(fillPrice) -
                    SafeCast.toInt256(pos.avgEntryPrice))
            : int256(absQty) *
                (SafeCast.toInt256(pos.avgEntryPrice) -
                    SafeCast.toInt256(fillPrice));

        uint256 releasedMargin = (pos.margin * absQty) / curAbs;
        pos.margin -= releasedMargin;
        pos.size = curSize + signedQty;

        int256 net = SafeCast.toInt256(releasedMargin) + pnl;
        if (net >= 0) {
            balanceOf[trader] += uint256(net);
        } else {
            uint256 deficit = uint256(-net);
            if (deficit <= pos.margin) {
                pos.margin -= deficit;
            } else {
                uint256 bad = deficit - pos.margin;
                pos.margin = 0;
                uint256 paid = insuranceFund.cover(address(this), bad);
                if (paid < bad) {
                    emit BadDebt(trader, marketId, bad - paid);
                }
            }
        }

        if (pos.size == 0) {
            pos.avgEntryPrice = 0;
            // any rounding dust left in margin is swept to protocol fees
            if (pos.margin > 0) {
                protocolFees += pos.margin;
                pos.margin = 0;
            }
        }
    }

    function _chargeFee(
        address trader,
        uint256 absQty,
        uint256 fillPrice,
        uint256 feeBps
    ) internal {
        uint256 fee = (absQty * fillPrice * feeBps) / BPS;
        if (fee > 0) {
            if (balanceOf[trader] < fee) revert InsufficientCollateral();
            balanceOf[trader] -= fee;
            protocolFees += fee;
        }
    }

    // --------------------------------------------------------------------- //
    //                              Liquidation                              //
    // --------------------------------------------------------------------- //

    /// @notice Liquidate an under-maintenance position at the mark price.
    function liquidate(
        address trader,
        uint256 marketId
    ) external nonReentrant whenNotPaused onlyRole(LIQUIDATOR_ROLE) {
        Position storage pos = _positions[trader][marketId];
        if (pos.size == 0) revert NoPosition();
        _settleFunding(pos, marketId);

        uint256 mark = oracle.getPriceChecked(marketId);
        (int256 equity, uint256 notional) = _equityAndNotional(pos, marketId, mark);

        uint256 maintReq = (notional * markets[marketId].maintenanceMarginBps) /
            BPS;
        if (equity >= SafeCast.toInt256(maintReq)) revert NotLiquidatable();

        uint256 penalty = (notional * markets[marketId].liquidationFeeBps) / BPS;
        _settleLiquidationPayout(trader, marketId, equity, penalty);

        pos.size = 0;
        pos.avgEntryPrice = 0;
        pos.margin = 0;
        pos.entryFundingIndex = cumulativeFundingIndex[marketId];

        emit Liquidated(trader, marketId, mark, penalty);
        emit PositionChanged(trader, marketId, 0, 0, 0);
    }

    function _settleLiquidationPayout(
        address trader,
        uint256 marketId,
        int256 equity,
        uint256 penalty
    ) internal {
        if (equity > 0) {
            uint256 eq = uint256(equity);
            uint256 pen = penalty <= eq ? penalty : eq;
            protocolFees += pen;
            uint256 toTrader = eq - pen;
            if (toTrader > 0) balanceOf[trader] += toTrader;
        } else {
            uint256 deficit = uint256(-equity);
            uint256 paid = insuranceFund.cover(address(this), deficit);
            if (paid < deficit) {
                emit BadDebt(trader, marketId, deficit - paid);
            }
        }
    }

    // --------------------------------------------------------------------- //
    //                               Internals                               //
    // --------------------------------------------------------------------- //

    function _lockMargin(
        address trader,
        Position storage pos,
        uint256 amount
    ) internal {
        if (balanceOf[trader] < amount) revert InsufficientCollateral();
        balanceOf[trader] -= amount;
        pos.margin += amount;
    }

    function _settleFunding(Position storage pos, uint256 marketId) internal {
        int256 idx = cumulativeFundingIndex[marketId];
        if (pos.size != 0) {
            int256 delta = idx - pos.entryFundingIndex;
            if (delta != 0) {
                int256 payment = (pos.size * delta) / FUNDING_SCALE; // >0 => pays
                if (payment > 0) {
                    // payer: capped at available margin so it can never go negative
                    uint256 p = uint256(payment);
                    if (p > pos.margin) p = pos.margin;
                    pos.margin -= p;
                    fundingPool += SafeCast.toInt256(p);
                } else if (payment < 0) {
                    // receiver: uncapped & order-independent; the pool nets out as
                    // payers settle. Any residual imbalance is backstopped by the
                    // insurance fund at liquidation/close.
                    uint256 owed = uint256(-payment);
                    pos.margin += owed;
                    fundingPool -= SafeCast.toInt256(owed);
                }
            }
        }
        pos.entryFundingIndex = idx;
    }

    function _requireInitialMargin(
        Position storage pos,
        uint256 marketId
    ) internal view {
        uint256 mark = oracle.getPriceChecked(marketId);
        (int256 equity, uint256 notional) = _equityAndNotional(
            pos,
            marketId,
            mark
        );
        uint256 initReq = (notional * markets[marketId].initialMarginBps) / BPS;
        if (equity < SafeCast.toInt256(initReq)) revert InitialMarginUnmet();
    }

    /// @dev Mark-to-market equity (margin + unrealised PnL) and notional at `mark`.
    function _equityAndNotional(
        Position storage pos,
        uint256 /* marketId */,
        uint256 mark
    ) internal view returns (int256 equity, uint256 notional) {
        uint256 absSize = _abs(pos.size);
        notional = absSize * mark;
        int256 pnl = pos.size > 0
            ? int256(absSize) *
                (SafeCast.toInt256(mark) -
                    SafeCast.toInt256(pos.avgEntryPrice))
            : int256(absSize) *
                (SafeCast.toInt256(pos.avgEntryPrice) -
                    SafeCast.toInt256(mark));
        equity = SafeCast.toInt256(pos.margin) + pnl;
    }

    function _orderDigest(Order calldata order) internal view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        ORDER_TYPEHASH,
                        order.trader,
                        order.marketId,
                        order.isBuy,
                        order.price,
                        order.amount,
                        order.marginBps,
                        order.nonce,
                        order.expiry,
                        order.reduceOnly
                    )
                )
            );
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    function _sameSign(int256 a, int256 b) internal pure returns (bool) {
        return (a > 0 && b > 0) || (a < 0 && b < 0);
    }

    // --------------------------------------------------------------------- //
    //                                 Admin                                 //
    // --------------------------------------------------------------------- //

    function pause() external onlyRole(WeBlockRoles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(WeBlockRoles.PAUSER_ROLE) {
        _unpause();
    }

    function withdrawFees(
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > protocolFees) revert ZeroAmount();
        protocolFees -= amount;
        quoteToken.safeTransfer(to, amount);
        emit FeesWithdrawn(to, amount);
    }

    // --------------------------------------------------------------------- //
    //                                 Views                                 //
    // --------------------------------------------------------------------- //

    function getPosition(
        address trader,
        uint256 marketId
    )
        external
        view
        returns (
            int256 size,
            uint256 avgEntryPrice,
            uint256 margin,
            int256 entryFundingIndex
        )
    {
        Position storage pos = _positions[trader][marketId];
        return (pos.size, pos.avgEntryPrice, pos.margin, pos.entryFundingIndex);
    }

    /// @notice Mark-to-market equity of a position (margin + unrealised PnL).
    function positionEquity(
        address trader,
        uint256 marketId
    ) public view returns (int256 equity) {
        Position storage pos = _positions[trader][marketId];
        if (pos.size == 0) return 0;
        uint256 mark = oracle.getPriceChecked(marketId);
        (equity, ) = _equityAndNotional(pos, marketId, mark);
    }

    /// @notice True if the position can be liquidated at the current mark.
    function isLiquidatable(
        address trader,
        uint256 marketId
    ) external view returns (bool) {
        Position storage pos = _positions[trader][marketId];
        if (pos.size == 0) return false;
        uint256 mark = oracle.getPriceChecked(marketId);
        uint256 notional = _abs(pos.size) * mark;
        uint256 maintReq = (notional * markets[marketId].maintenanceMarginBps) /
            BPS;
        return positionEquity(trader, marketId) < SafeCast.toInt256(maintReq);
    }

    function orderDigest(Order calldata order) external view returns (bytes32) {
        return _orderDigest(order);
    }
}
