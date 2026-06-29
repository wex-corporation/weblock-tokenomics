// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";
import {IKycRegistry} from "../interfaces/IKycRegistry.sol";

/// @title SpotExchange
/// @notice Non-custodial, off-chain-matched RBT secondary market. Traders sign EIP-712 orders;
///         the backend matcher (SETTLEMENT_ROLE) submits matched pairs and the contract atomically
///         swaps quote-token (buyer→seller, minus fee) and RBT (seller→buyer). Partial fills are
///         tracked per order hash; nonces can be invalidated by the trader as a cancel safety hatch.
/// @dev The exchange is RBT-gate-exempt (escrow operator), so it enforces buyer KYC itself.
contract SpotExchange is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    struct Order {
        address trader;
        uint256 marketId; // RBT tokenId
        bool isBuy;
        uint256 price; // quote (6dp) per RBT unit
        uint256 amount; // RBT units (total order size)
        uint256 nonce;
        uint256 expiry;
    }

    bytes32 private constant ORDER_TYPEHASH = keccak256(
        "Order(address trader,uint256 marketId,bool isBuy,uint256 price,uint256 amount,uint256 nonce,uint256 expiry)"
    );

    IERC1155 public immutable rbt;
    IERC20 public immutable quote; // settlement currency (e.g. USDC/USDR, 6dp)
    IKycRegistry public immutable kyc;
    address public feeTreasury;
    uint256 public feeBps; // taker-side platform fee (e.g. 100 = 1%)

    mapping(bytes32 => uint256) public filled; // orderHash => filled amount
    mapping(address => mapping(uint256 => bool)) public nonceInvalidated;

    event Settled(
        uint256 indexed marketId,
        address indexed buyer,
        address indexed seller,
        uint256 price,
        uint256 amount,
        uint256 quoteAmount,
        uint256 fee
    );
    event NonceInvalidated(address indexed trader, uint256 nonce);
    event FeeConfigUpdated(address feeTreasury, uint256 feeBps);

    constructor(address admin, address rbt_, address quote_, address kyc_, address feeTreasury_, uint256 feeBps_)
        EIP712("WeBlockSpot", "1")
    {
        if (admin == address(0) || rbt_ == address(0) || quote_ == address(0) || kyc_ == address(0) || feeTreasury_ == address(0)) {
            revert Errors.ZeroAddress();
        }
        rbt = IERC1155(rbt_);
        quote = IERC20(quote_);
        kyc = IKycRegistry(kyc_);
        feeTreasury = feeTreasury_;
        feeBps = feeBps_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.SETTLEMENT_ROLE, admin);
        _grantRole(Roles.MARKET_ADMIN_ROLE, admin);
    }

    function hashOrder(Order calldata o) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(ORDER_TYPEHASH, o.trader, o.marketId, o.isBuy, o.price, o.amount, o.nonce, o.expiry))
        );
    }

    function _verify(Order calldata o, bytes calldata sig) internal view returns (bytes32 digest) {
        digest = hashOrder(o);
        if (ECDSA.recover(digest, sig) != o.trader) revert Errors.BadSignature();
        if (block.timestamp > o.expiry) revert Errors.Expired();
        if (nonceInvalidated[o.trader][o.nonce]) revert Errors.NonceUsed();
    }

    /// @notice Settle a matched buy/sell pair for `fillAmount` RBT units at `fillPrice`.
    function settle(Order calldata buy, bytes calldata buySig, Order calldata sell, bytes calldata sellSig, uint256 fillAmount, uint256 fillPrice)
        external
        onlyRole(Roles.SETTLEMENT_ROLE)
        nonReentrant
    {
        if (!buy.isBuy || sell.isBuy) revert Errors.InvalidState();
        if (buy.marketId != sell.marketId) revert Errors.InvalidState();
        if (fillAmount == 0) revert Errors.ZeroAmount();
        if (buy.trader == sell.trader) revert Errors.SelfTrade();
        // crossable + fill price within both limits
        if (fillPrice > buy.price || fillPrice < sell.price) revert Errors.PriceCrossed();
        if (!kyc.isVerified(buy.trader)) revert Errors.NotKycVerified(buy.trader);

        bytes32 buyHash = _verify(buy, buySig);
        bytes32 sellHash = _verify(sell, sellSig);

        if (filled[buyHash] + fillAmount > buy.amount) revert Errors.ExceedsMaxSupply();
        if (filled[sellHash] + fillAmount > sell.amount) revert Errors.ExceedsMaxSupply();
        filled[buyHash] += fillAmount;
        filled[sellHash] += fillAmount;

        uint256 quoteAmount = fillAmount * fillPrice;
        uint256 fee = (quoteAmount * feeBps) / 10_000;

        // buyer pays quote: seller receives (quoteAmount - fee), treasury receives fee
        quote.safeTransferFrom(buy.trader, sell.trader, quoteAmount - fee);
        if (fee > 0) quote.safeTransferFrom(buy.trader, feeTreasury, fee);
        // seller delivers RBT (seller must have approved this exchange as ERC1155 operator)
        rbt.safeTransferFrom(sell.trader, buy.trader, buy.marketId, fillAmount, "");

        emit Settled(buy.marketId, buy.trader, sell.trader, fillPrice, fillAmount, quoteAmount, fee);
    }

    function invalidateNonce(uint256 nonce) external {
        nonceInvalidated[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    function setFeeConfig(address feeTreasury_, uint256 feeBps_) external onlyRole(Roles.MARKET_ADMIN_ROLE) {
        if (feeTreasury_ == address(0)) revert Errors.ZeroAddress();
        if (feeBps_ > 1000) revert Errors.InvalidState(); // hard cap 10%
        feeTreasury = feeTreasury_;
        feeBps = feeBps_;
        emit FeeConfigUpdated(feeTreasury_, feeBps_);
    }
}
