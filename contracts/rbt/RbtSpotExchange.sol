// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/**
 * @title RbtSpotExchange
 * @notice Non-custodial settlement for the RBT spot (secondary) market (backend B2). Orders are
 *         matched OFF-CHAIN by SpotMatchingEngine; the operator submits each matched pair here and
 *         this contract verifies both EIP-712 signatures and atomically swaps RBT (ERC-1155) for
 *         the quote stablecoin (ERC-20). Mirrors the hybrid design of PerpClearing. Funds never rest
 *         in the contract: tokens move directly maker&harr;taker on settlement.
 * @dev Pre-audit, testnet only. Partial fills + replay are bounded by `filled[orderHash]`.
 */
contract RbtSpotExchange is AccessControl, ReentrancyGuard, Pausable, EIP712 {
    using SafeERC20 for IERC20;

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    bytes32 private constant SPOT_ORDER_TYPEHASH =
        keccak256(
            "SpotOrder(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 nonce,uint256 expiry)"
        );

    IERC1155 public immutable rbt;
    IERC20 public immutable quote;
    address public feeTreasury;
    uint16 public feeBps; // per side (buyer + seller each), in basis points

    struct SpotOrder {
        address trader;
        uint256 marketId;
        bool isBuy;
        uint256 price;
        uint256 amount;
        uint256 nonce;
        uint256 expiry;
    }

    struct Fill {
        SpotOrder buyOrder;
        bytes buySig;
        SpotOrder sellOrder;
        bytes sellSig;
        uint256 amount;
        uint256 price;
    }

    mapping(bytes32 => uint256) public filled; // orderHash => cumulative filled amount

    error BadPair();
    error SelfTrade();
    error ZeroParams();
    error Expired();
    error PriceCross();
    error BadSignature();
    error Overfill();

    event FeeUpdated(address indexed treasury, uint16 feeBps);
    event Settled(
        bytes32 indexed buyHash,
        bytes32 indexed sellHash,
        address buyer,
        address seller,
        uint256 marketId,
        uint256 amount,
        uint256 price
    );

    constructor(
        address admin,
        IERC1155 rbt_,
        IERC20 quote_,
        address feeTreasury_,
        uint16 feeBps_
    ) EIP712("WeBlockSpot", "1") {
        if (
            admin == address(0) ||
            address(rbt_) == address(0) ||
            address(quote_) == address(0) ||
            feeTreasury_ == address(0)
        ) {
            revert ZeroParams();
        }
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(OPERATOR_ROLE, admin);
        rbt = rbt_;
        quote = quote_;
        feeTreasury = feeTreasury_;
        feeBps = feeBps_;
    }

    function setFee(address treasury, uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (treasury == address(0)) revert ZeroParams();
        feeTreasury = treasury;
        feeBps = bps;
        emit FeeUpdated(treasury, bps);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Settle one matched (buy, sell) pair at a single price.
    function settle(Fill calldata f)
        external
        onlyRole(OPERATOR_ROLE)
        nonReentrant
        whenNotPaused
    {
        SpotOrder calldata b = f.buyOrder;
        SpotOrder calldata s = f.sellOrder;

        if (!b.isBuy || s.isBuy || b.marketId != s.marketId) revert BadPair();
        if (b.trader == s.trader) revert SelfTrade();
        if (f.amount == 0 || f.price == 0) revert ZeroParams();
        if (block.timestamp > b.expiry || block.timestamp > s.expiry) revert Expired();
        // buyer must bid >= fill price >= seller ask
        if (b.price < f.price || s.price > f.price) revert PriceCross();

        bytes32 bh = _hashOrder(b);
        bytes32 sh = _hashOrder(s);
        if (ECDSA.recover(bh, f.buySig) != b.trader) revert BadSignature();
        if (ECDSA.recover(sh, f.sellSig) != s.trader) revert BadSignature();

        {
            uint256 nb = filled[bh] + f.amount;
            uint256 ns = filled[sh] + f.amount;
            if (nb > b.amount || ns > s.amount) revert Overfill();
            filled[bh] = nb;
            filled[sh] = ns;
        }

        _swap(b.trader, s.trader, b.marketId, f.amount, f.price);
        emit Settled(bh, sh, b.trader, s.trader, b.marketId, f.amount, f.price);
    }

    /// @dev buyer funds: seller proceeds (gross - fee) + both-side fees (2*fee) to treasury.
    function _swap(
        address buyer,
        address seller,
        uint256 marketId,
        uint256 amount,
        uint256 price
    ) private {
        uint256 grossQuote = amount * price;
        uint256 fee = (uint256(feeBps) * grossQuote) / 10_000;
        quote.safeTransferFrom(buyer, seller, grossQuote - fee);
        if (fee > 0) {
            quote.safeTransferFrom(buyer, feeTreasury, fee * 2);
        }
        rbt.safeTransferFrom(seller, buyer, marketId, amount, "");
    }

    function _hashOrder(SpotOrder calldata o) internal view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        SPOT_ORDER_TYPEHASH,
                        o.trader,
                        o.marketId,
                        o.isBuy,
                        o.price,
                        o.amount,
                        o.nonce,
                        o.expiry
                    )
                )
            );
    }
}
