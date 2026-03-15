// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {RealEstateBackedToken} from "../tokens/RealEstateBackedToken.sol";
import {RBTSeriesManager} from "./RBTSeriesManager.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

contract RBTOrderBook is ERC1155Holder, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Side {
        Ask,
        Bid
    }

    enum OrderStatus {
        Open,
        Filled,
        Cancelled
    }

    struct Order {
        uint256 id;
        address maker;
        uint256 tokenId;
        address paymentToken;
        Side side;
        uint64 expiry;
        uint128 pricePerUnit;
        uint128 initialQuantity;
        uint128 remainingQuantity;
        OrderStatus status;
    }

    RealEstateBackedToken public immutable rbtToken;
    RBTSeriesManager public immutable seriesManager;
    uint256 public nextOrderId;

    mapping(uint256 => Order) public orders;

    event OrderCreated(
        uint256 indexed orderId,
        address indexed maker,
        uint256 indexed tokenId,
        Side side,
        address paymentToken,
        uint256 quantity,
        uint256 pricePerUnit,
        uint256 expiry
    );
    event OrderFilled(
        uint256 indexed orderId,
        address indexed filler,
        uint256 quantity,
        uint256 grossSettlement,
        address beneficiary
    );
    event OrderCancelled(
        uint256 indexed orderId,
        address indexed maker,
        uint256 remainingQuantity
    );

    constructor(address admin, address token_, address seriesManager_) {
        if (
            admin == address(0) ||
            token_ == address(0) ||
            seriesManager_ == address(0)
        ) {
            revert WeBlockErrors.ZeroAddress();
        }

        rbtToken = RealEstateBackedToken(token_);
        seriesManager = RBTSeriesManager(seriesManager_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.OPERATOR_ROLE, admin);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155Holder, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function createAsk(
        uint256 tokenId,
        address paymentToken,
        uint128 quantity,
        uint128 pricePerUnit,
        uint64 expiry
    ) external nonReentrant returns (uint256 orderId) {
        _enforceTradable(tokenId, paymentToken, quantity, pricePerUnit, expiry);

        orderId = ++nextOrderId;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            tokenId: tokenId,
            paymentToken: paymentToken,
            side: Side.Ask,
            expiry: expiry,
            pricePerUnit: pricePerUnit,
            initialQuantity: quantity,
            remainingQuantity: quantity,
            status: OrderStatus.Open
        });

        rbtToken.safeTransferFrom(
            msg.sender,
            address(this),
            tokenId,
            quantity,
            ""
        );
        emit OrderCreated(
            orderId,
            msg.sender,
            tokenId,
            Side.Ask,
            paymentToken,
            quantity,
            pricePerUnit,
            expiry
        );
    }

    function createBid(
        uint256 tokenId,
        address paymentToken,
        uint128 quantity,
        uint128 pricePerUnit,
        uint64 expiry
    ) external nonReentrant returns (uint256 orderId) {
        _enforceTradable(tokenId, paymentToken, quantity, pricePerUnit, expiry);

        orderId = ++nextOrderId;
        orders[orderId] = Order({
            id: orderId,
            maker: msg.sender,
            tokenId: tokenId,
            paymentToken: paymentToken,
            side: Side.Bid,
            expiry: expiry,
            pricePerUnit: pricePerUnit,
            initialQuantity: quantity,
            remainingQuantity: quantity,
            status: OrderStatus.Open
        });

        IERC20(paymentToken).safeTransferFrom(
            msg.sender,
            address(this),
            uint256(quantity) * uint256(pricePerUnit)
        );
        emit OrderCreated(
            orderId,
            msg.sender,
            tokenId,
            Side.Bid,
            paymentToken,
            quantity,
            pricePerUnit,
            expiry
        );
    }

    function fillOrder(
        uint256 orderId,
        uint128 quantity,
        address beneficiary
    ) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Open) {
            revert WeBlockErrors.OrderClosed();
        }
        if (block.timestamp > order.expiry) {
            revert WeBlockErrors.OrderExpired();
        }
        if (quantity == 0 || quantity > order.remainingQuantity) {
            revert WeBlockErrors.QuantityTooHigh();
        }
        if (beneficiary == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        uint256 grossSettlement =
            uint256(quantity) * uint256(order.pricePerUnit);
        address recipient = order.side == Side.Bid ? order.maker : beneficiary;
        order.remainingQuantity -= quantity;
        if (order.remainingQuantity == 0) {
            order.status = OrderStatus.Filled;
        }

        if (order.side == Side.Ask) {
            IERC20(order.paymentToken).safeTransferFrom(
                msg.sender,
                order.maker,
                grossSettlement
            );
            rbtToken.safeTransferFrom(
                address(this),
                recipient,
                order.tokenId,
                quantity,
                ""
            );
        } else {
            rbtToken.safeTransferFrom(
                msg.sender,
                recipient,
                order.tokenId,
                quantity,
                ""
            );
            IERC20(order.paymentToken).safeTransfer(
                msg.sender,
                grossSettlement
            );
        }

        emit OrderFilled(
            orderId,
            msg.sender,
            quantity,
            grossSettlement,
            recipient
        );
    }

    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage order = orders[orderId];
        if (order.status != OrderStatus.Open) {
            revert WeBlockErrors.OrderClosed();
        }
        if (
            msg.sender != order.maker &&
            !hasRole(WeBlockRoles.OPERATOR_ROLE, msg.sender)
        ) {
            revert WeBlockErrors.UnauthorizedCaller();
        }

        order.status = OrderStatus.Cancelled;
        uint256 remainingQuantity = order.remainingQuantity;
        order.remainingQuantity = 0;

        if (remainingQuantity != 0) {
            if (order.side == Side.Ask) {
                rbtToken.safeTransferFrom(
                    address(this),
                    order.maker,
                    order.tokenId,
                    remainingQuantity,
                    ""
                );
            } else {
                IERC20(order.paymentToken).safeTransfer(
                    order.maker,
                    remainingQuantity * uint256(order.pricePerUnit)
                );
            }
        }

        emit OrderCancelled(orderId, order.maker, remainingQuantity);
    }

    function _enforceTradable(
        uint256 tokenId,
        address paymentToken,
        uint128 quantity,
        uint128 pricePerUnit,
        uint64 expiry
    ) private view {
        if (!seriesManager.isSeriesActiveForTrading(tokenId)) {
            revert WeBlockErrors.TransferNotAllowed();
        }
        if (!seriesManager.paymentTokenEnabled(tokenId, paymentToken)) {
            revert WeBlockErrors.UnsupportedPaymentToken();
        }
        if (quantity == 0 || pricePerUnit == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }
        if (expiry <= block.timestamp) {
            revert WeBlockErrors.OrderExpired();
        }
    }
}
