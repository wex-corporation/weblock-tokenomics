// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";
import {IRBTGate} from "../interfaces/IRBTGate.sol";
import {IKycRegistry} from "../interfaces/IKycRegistry.sol";
import {RBT} from "../tokens/RBT.sol";

/// @title SeriesManager
/// @notice Primary issuance + lifecycle for RBT property series, and the RBT secondary transfer
///         gate. One `tokenId` per property. Income/rent distribution is handled separately by
///         IncomeDistributor (Merkle, monthly). Funds are held by this contract under per-series
///         accounting; redemption pays pro-rata at maturity.
contract SeriesManager is AccessControl, ReentrancyGuard, IRBTGate {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Draft,
        Sale,
        Active,
        Delinquent,
        Defaulted,
        Matured,
        Cancelled
    }

    struct Series {
        State state;
        address issuerTreasury;
        uint64 saleStart;
        uint64 saleEnd;
        uint64 maturityAt;
        uint256 pricePerToken; // pay-token base units (6dp) per 1 RBT unit
        uint256 maxSupply; // RBT units
        uint256 sold; // RBT units sold
        bool secondaryEnabled;
        address redemptionToken;
        uint256 redemptionPerToken; // pay-token base units per RBT unit (set at enableRedemption)
    }

    RBT public immutable rbt;
    IKycRegistry public immutable kyc;

    mapping(uint256 => Series) public series; // tokenId => Series
    mapping(uint256 => address[]) public seriesPayTokens; // tokenId => allowed pay tokens
    mapping(uint256 => mapping(address => bool)) public payTokenAllowed;
    mapping(uint256 => mapping(address => uint256)) public saleEscrow; // tokenId => payToken => held
    mapping(uint256 => mapping(address => mapping(address => uint256))) public contributed; // tokenId => buyer => payToken => amt
    mapping(uint256 => mapping(address => uint256)) public boughtQty; // tokenId => buyer => RBT units

    event SeriesCreated(uint256 indexed tokenId, address issuerTreasury, uint256 pricePerToken, uint256 maxSupply);
    event SaleOpened(uint256 indexed tokenId);
    event Bought(uint256 indexed tokenId, address indexed buyer, address payToken, uint256 quantity, uint256 cost);
    event SaleFinalized(uint256 indexed tokenId, uint256 totalReleased);
    event SaleCancelled(uint256 indexed tokenId);
    event Refunded(uint256 indexed tokenId, address indexed buyer, uint256 quantity);
    event Delinquent(uint256 indexed tokenId);
    event Cured(uint256 indexed tokenId);
    event Defaulted(uint256 indexed tokenId);
    event Matured(uint256 indexed tokenId);
    event RedemptionEnabled(uint256 indexed tokenId, address token, uint256 perToken, uint256 totalDeposited);
    event Redeemed(uint256 indexed tokenId, address indexed holder, uint256 quantity, uint256 payout);

    constructor(address admin, address rbt_, address kyc_) {
        if (admin == address(0) || rbt_ == address(0) || kyc_ == address(0)) revert Errors.ZeroAddress();
        rbt = RBT(rbt_);
        kyc = IKycRegistry(kyc_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.OPERATOR_ROLE, admin);
        _grantRole(Roles.TREASURY_FUNDER_ROLE, admin);
        _grantRole(Roles.DELINQUENCY_MANAGER_ROLE, admin);
    }

    // ------------------------------------------------------------------ gate
    /// @inheritdoc IRBTGate
    function checkTransfer(address, address from, address to, uint256 id, uint256) external view {
        Series storage s = series[id];
        if (s.state != State.Active && s.state != State.Matured) revert Errors.TransferNotAllowed();
        if (!s.secondaryEnabled) revert Errors.TransferNotAllowed();
        if (!kyc.isVerified(from)) revert Errors.NotKycVerified(from);
        if (!kyc.isVerified(to)) revert Errors.NotKycVerified(to);
    }

    // -------------------------------------------------------------- lifecycle
    function createSeries(
        uint256 tokenId,
        address issuerTreasury,
        uint64 saleStart,
        uint64 saleEnd,
        uint64 maturityAt,
        uint256 pricePerToken,
        uint256 maxSupply,
        bool secondaryEnabled,
        address[] calldata payTokens
    ) external onlyRole(Roles.OPERATOR_ROLE) {
        if (series[tokenId].state != State.None) revert Errors.SeriesExists(tokenId);
        if (issuerTreasury == address(0)) revert Errors.ZeroAddress();
        if (pricePerToken == 0 || maxSupply == 0 || payTokens.length == 0) revert Errors.ZeroAmount();

        Series storage s = series[tokenId];
        s.state = State.Draft;
        s.issuerTreasury = issuerTreasury;
        s.saleStart = saleStart;
        s.saleEnd = saleEnd;
        s.maturityAt = maturityAt;
        s.pricePerToken = pricePerToken;
        s.maxSupply = maxSupply;
        s.secondaryEnabled = secondaryEnabled;

        for (uint256 i; i < payTokens.length; ++i) {
            if (payTokens[i] == address(0)) revert Errors.ZeroAddress();
            if (!payTokenAllowed[tokenId][payTokens[i]]) {
                payTokenAllowed[tokenId][payTokens[i]] = true;
                seriesPayTokens[tokenId].push(payTokens[i]);
            }
        }
        emit SeriesCreated(tokenId, issuerTreasury, pricePerToken, maxSupply);
    }

    function openSale(uint256 tokenId) external onlyRole(Roles.OPERATOR_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Draft) revert Errors.InvalidState();
        s.state = State.Sale;
        emit SaleOpened(tokenId);
    }

    function buy(uint256 tokenId, address payToken, uint256 quantity) external nonReentrant {
        Series storage s = series[tokenId];
        if (s.state != State.Sale) revert Errors.SaleNotActive();
        if (block.timestamp < s.saleStart || block.timestamp > s.saleEnd) revert Errors.SaleNotActive();
        if (!payTokenAllowed[tokenId][payToken]) revert Errors.UnsupportedPayToken(payToken);
        if (quantity == 0) revert Errors.ZeroAmount();
        if (s.sold + quantity > s.maxSupply) revert Errors.ExceedsMaxSupply();
        if (!kyc.isVerified(msg.sender)) revert Errors.NotKycVerified(msg.sender);

        uint256 cost = quantity * s.pricePerToken;
        s.sold += quantity;
        saleEscrow[tokenId][payToken] += cost;
        contributed[tokenId][msg.sender][payToken] += cost;
        boughtQty[tokenId][msg.sender] += quantity;

        IERC20(payToken).safeTransferFrom(msg.sender, address(this), cost);
        rbt.mint(msg.sender, tokenId, quantity);
        emit Bought(tokenId, msg.sender, payToken, quantity, cost);
    }

    function finalizeSale(uint256 tokenId) external onlyRole(Roles.OPERATOR_ROLE) nonReentrant {
        Series storage s = series[tokenId];
        if (s.state != State.Sale) revert Errors.InvalidState();
        s.state = State.Active;

        uint256 totalReleased;
        address[] storage toks = seriesPayTokens[tokenId];
        for (uint256 i; i < toks.length; ++i) {
            uint256 amt = saleEscrow[tokenId][toks[i]];
            if (amt > 0) {
                saleEscrow[tokenId][toks[i]] = 0;
                totalReleased += amt;
                IERC20(toks[i]).safeTransfer(s.issuerTreasury, amt);
            }
        }
        emit SaleFinalized(tokenId, totalReleased);
    }

    function cancelSale(uint256 tokenId) external onlyRole(Roles.OPERATOR_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Draft && s.state != State.Sale) revert Errors.InvalidState();
        s.state = State.Cancelled;
        emit SaleCancelled(tokenId);
    }

    /// @notice Buyer reclaims contributed funds and burns their RBT after a sale is cancelled.
    function refund(uint256 tokenId) external nonReentrant {
        Series storage s = series[tokenId];
        if (s.state != State.Cancelled) revert Errors.InvalidState();
        uint256 qty = boughtQty[tokenId][msg.sender];
        if (qty == 0) revert Errors.ZeroAmount();
        boughtQty[tokenId][msg.sender] = 0;

        address[] storage toks = seriesPayTokens[tokenId];
        for (uint256 i; i < toks.length; ++i) {
            uint256 amt = contributed[tokenId][msg.sender][toks[i]];
            if (amt > 0) {
                contributed[tokenId][msg.sender][toks[i]] = 0;
                saleEscrow[tokenId][toks[i]] -= amt;
                IERC20(toks[i]).safeTransfer(msg.sender, amt);
            }
        }
        rbt.burn(msg.sender, tokenId, qty);
        emit Refunded(tokenId, msg.sender, qty);
    }

    // ------------------------------------------------------- delinquency / default
    function markDelinquent(uint256 tokenId) external onlyRole(Roles.DELINQUENCY_MANAGER_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Active) revert Errors.InvalidState();
        s.state = State.Delinquent;
        emit Delinquent(tokenId);
    }

    function cure(uint256 tokenId) external onlyRole(Roles.DELINQUENCY_MANAGER_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Delinquent) revert Errors.InvalidState();
        s.state = State.Active;
        emit Cured(tokenId);
    }

    function declareDefault(uint256 tokenId) external onlyRole(Roles.DELINQUENCY_MANAGER_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Active && s.state != State.Delinquent) revert Errors.InvalidState();
        s.state = State.Defaulted;
        emit Defaulted(tokenId);
    }

    // --------------------------------------------------------- maturity / redeem
    function enterMaturity(uint256 tokenId) external onlyRole(Roles.OPERATOR_ROLE) {
        Series storage s = series[tokenId];
        if (s.state != State.Active && s.state != State.Delinquent) revert Errors.InvalidState();
        s.state = State.Matured;
        emit Matured(tokenId);
    }

    function enableRedemption(uint256 tokenId, address token, uint256 redemptionPerToken)
        external
        onlyRole(Roles.TREASURY_FUNDER_ROLE)
        nonReentrant
    {
        Series storage s = series[tokenId];
        if (s.state != State.Matured) revert Errors.InvalidState();
        if (token == address(0) || redemptionPerToken == 0) revert Errors.ZeroAmount();
        uint256 supply = rbt.totalSupply(tokenId);
        uint256 total = redemptionPerToken * supply;
        s.redemptionToken = token;
        s.redemptionPerToken = redemptionPerToken;
        IERC20(token).safeTransferFrom(msg.sender, address(this), total);
        emit RedemptionEnabled(tokenId, token, redemptionPerToken, total);
    }

    function redeem(uint256 tokenId, uint256 quantity) external nonReentrant {
        Series storage s = series[tokenId];
        if (s.state != State.Matured || s.redemptionPerToken == 0) revert Errors.NotMatured();
        if (quantity == 0) revert Errors.ZeroAmount();
        uint256 payout = quantity * s.redemptionPerToken;
        rbt.burn(msg.sender, tokenId, quantity); // reverts if caller lacks balance
        IERC20(s.redemptionToken).safeTransfer(msg.sender, payout);
        emit Redeemed(tokenId, msg.sender, quantity, payout);
    }

    // -------------------------------------------------------------------- views
    function getSeries(uint256 tokenId) external view returns (Series memory) {
        return series[tokenId];
    }

    function payTokensOf(uint256 tokenId) external view returns (address[] memory) {
        return seriesPayTokens[tokenId];
    }
}
