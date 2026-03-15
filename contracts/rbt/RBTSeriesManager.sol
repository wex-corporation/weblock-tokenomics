// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IRBTLifecycleManager} from "../interfaces/IRBTLifecycleManager.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";
import {RealEstateBackedToken} from "../tokens/RealEstateBackedToken.sol";
import {RotatingVaultRouter} from "./RotatingVaultRouter.sol";

contract RBTSeriesManager is
    AccessControl,
    ReentrancyGuard,
    IRBTLifecycleManager
{
    using SafeERC20 for IERC20;

    uint256 public constant ACCURACY = 1e18;

    enum SeriesState {
        Draft,
        Sale,
        Active,
        Delinquent,
        Matured,
        Defaulted,
        Cancelled
    }

    struct Series {
        bool exists;
        uint64 saleStart;
        uint64 saleEnd;
        uint64 maturityDate;
        uint64 activatedAt;
        uint128 maxSupply;
        uint128 soldSupply;
        address issuerTreasury;
        bool secondaryTradingEnabled;
        SeriesState state;
        string propertyCode;
        string propertyName;
        string roundLabel;
        string metadataURI;
        string cancellationMemo;
        string delinquencyMemo;
        string defaultMemo;
    }

    struct CreateSeriesParams {
        uint256 tokenId;
        uint64 saleStart;
        uint64 saleEnd;
        uint64 maturityDate;
        uint128 maxSupply;
        address issuerTreasury;
        bool secondaryTradingEnabled;
        string propertyCode;
        string propertyName;
        uint32 roundNumber;
        string roundLabel;
        string metadataURI;
    }

    RealEstateBackedToken public immutable rbtToken;
    RotatingVaultRouter public immutable interestRouter;
    RotatingVaultRouter public immutable redemptionRouter;

    mapping(uint256 => Series) private _seriesById;
    mapping(uint256 => uint32) public roundNumberBySeries;
    mapping(uint256 => address[]) private _paymentTokensBySeries;
    mapping(uint256 => mapping(address => bool)) public paymentTokenEnabled;
    mapping(uint256 => mapping(address => uint256))
        public unitPriceByPaymentToken;
    mapping(uint256 => mapping(address => uint256))
        public escrowedByPaymentToken;
    mapping(uint256 => mapping(address => mapping(address => uint256)))
        public contributedByAccount;
    mapping(uint256 => mapping(address => uint256)) public accInterestPerShare;
    mapping(address => mapping(uint256 => mapping(address => uint256)))
        public interestDebt;
    mapping(address => mapping(uint256 => mapping(address => uint256)))
        public pendingInterest;
    mapping(uint256 => mapping(address => bool)) public redemptionEnabled;
    mapping(uint256 => mapping(address => uint256)) public redemptionPerToken;
    mapping(uint256 => mapping(address => uint256))
        public redemptionSupplySnapshot;

    event SeriesCreated(
        uint256 indexed tokenId,
        string propertyCode,
        string propertyName,
        string roundLabel,
        uint256 maxSupply
    );
    event PaymentTokenConfigured(
        uint256 indexed tokenId,
        address indexed paymentToken,
        uint256 unitPrice,
        bool enabled
    );
    event SaleOpened(
        uint256 indexed tokenId,
        uint256 saleStart,
        uint256 saleEnd
    );
    event SeriesTreasuryUpdated(
        uint256 indexed tokenId,
        address indexed treasury
    );
    event SalePurchase(
        uint256 indexed tokenId,
        address indexed buyer,
        address indexed beneficiary,
        address paymentToken,
        uint256 quantity,
        uint256 totalCost
    );
    event SaleFinalized(
        uint256 indexed tokenId,
        uint256 soldSupply,
        uint256 activatedAt
    );
    event SaleCancelled(uint256 indexed tokenId, string memo);
    event RefundClaimed(
        uint256 indexed tokenId,
        address indexed account,
        address indexed paymentToken,
        uint256 amount
    );
    event InterestFunded(
        uint256 indexed tokenId,
        address indexed paymentToken,
        uint256 amount,
        uint256 newAccInterestPerShare
    );
    event InterestClaimed(
        uint256 indexed tokenId,
        address indexed account,
        address indexed paymentToken,
        uint256 amount
    );
    event SeriesDelinquent(uint256 indexed tokenId, string memo);
    event SeriesDelinquencyCured(uint256 indexed tokenId);
    event SeriesDefaulted(uint256 indexed tokenId, string memo);
    event SeriesMatured(uint256 indexed tokenId, uint256 timestamp);
    event RedemptionEnabled(
        uint256 indexed tokenId,
        address indexed paymentToken,
        uint256 totalAmount,
        uint256 perTokenPayout
    );
    event Redeemed(
        uint256 indexed tokenId,
        address indexed account,
        address indexed paymentToken,
        uint256 quantity,
        uint256 payout
    );

    modifier seriesExists(uint256 tokenId) {
        if (!_seriesById[tokenId].exists) {
            revert WeBlockErrors.SeriesNotFound();
        }
        _;
    }

    constructor(
        address admin,
        address token_,
        address interestRouter_,
        address redemptionRouter_
    ) {
        if (
            admin == address(0) ||
            token_ == address(0) ||
            interestRouter_ == address(0) ||
            redemptionRouter_ == address(0)
        ) {
            revert WeBlockErrors.ZeroAddress();
        }

        rbtToken = RealEstateBackedToken(token_);
        interestRouter = RotatingVaultRouter(interestRouter_);
        redemptionRouter = RotatingVaultRouter(redemptionRouter_);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(WeBlockRoles.OPERATOR_ROLE, admin);
        _grantRole(WeBlockRoles.TREASURY_FUNDER_ROLE, admin);
        _grantRole(WeBlockRoles.DELINQUENCY_MANAGER_ROLE, admin);
    }

    function createSeries(
        CreateSeriesParams calldata params,
        address[] calldata paymentTokens,
        uint256[] calldata unitPrices
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) {
        if (params.issuerTreasury == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }
        if (
            paymentTokens.length == 0 ||
            paymentTokens.length != unitPrices.length
        ) {
            revert WeBlockErrors.InvalidArrayLength();
        }
        if (
            params.saleStart >= params.saleEnd ||
            params.saleEnd >= params.maturityDate
        ) {
            revert WeBlockErrors.SaleWindowInvalid();
        }
        if (_seriesById[params.tokenId].exists || params.maxSupply == 0) {
            revert WeBlockErrors.SeriesAlreadyExists();
        }

        _seriesById[params.tokenId] = Series({
            exists: true,
            saleStart: params.saleStart,
            saleEnd: params.saleEnd,
            maturityDate: params.maturityDate,
            activatedAt: 0,
            maxSupply: params.maxSupply,
            soldSupply: 0,
            issuerTreasury: params.issuerTreasury,
            secondaryTradingEnabled: params.secondaryTradingEnabled,
            state: SeriesState.Draft,
            propertyCode: params.propertyCode,
            propertyName: params.propertyName,
            roundLabel: params.roundLabel,
            metadataURI: params.metadataURI,
            cancellationMemo: "",
            delinquencyMemo: "",
            defaultMemo: ""
        });

        roundNumberBySeries[params.tokenId] = params.roundNumber;

        rbtToken.registerSeries(
            params.tokenId,
            params.propertyCode,
            params.propertyName,
            params.roundNumber,
            params.roundLabel,
            params.metadataURI
        );

        _configurePaymentTokens(params.tokenId, paymentTokens, unitPrices);

        emit SeriesCreated(
            params.tokenId,
            params.propertyCode,
            params.propertyName,
            params.roundLabel,
            params.maxSupply
        );
    }

    function configurePaymentTokens(
        uint256 tokenId,
        address[] calldata paymentTokens,
        uint256[] calldata unitPrices
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        Series storage series = _seriesById[tokenId];
        if (
            series.state != SeriesState.Draft &&
            series.state != SeriesState.Sale
        ) {
            revert WeBlockErrors.UnsupportedSeriesState();
        }

        _configurePaymentTokens(tokenId, paymentTokens, unitPrices);
    }

    function openSale(
        uint256 tokenId
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        Series storage series = _seriesById[tokenId];
        if (series.state != SeriesState.Draft) {
            revert WeBlockErrors.InvalidStateTransition();
        }
        if (_paymentTokensBySeries[tokenId].length == 0) {
            revert WeBlockErrors.UnsupportedPaymentToken();
        }

        series.state = SeriesState.Sale;
        emit SaleOpened(tokenId, series.saleStart, series.saleEnd);
    }

    function setIssuerTreasury(
        uint256 tokenId,
        address treasury
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        if (treasury == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }
        Series storage series = _seriesById[tokenId];
        if (
            series.state == SeriesState.Active ||
            series.state == SeriesState.Matured
        ) {
            revert WeBlockErrors.InvalidStateTransition();
        }

        series.issuerTreasury = treasury;
        emit SeriesTreasuryUpdated(tokenId, treasury);
    }

    function updateSecondaryTrading(
        uint256 tokenId,
        bool enabled
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        _seriesById[tokenId].secondaryTradingEnabled = enabled;
    }

    function updateMetadataURI(
        uint256 tokenId,
        string calldata metadataURI
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        _seriesById[tokenId].metadataURI = metadataURI;
        rbtToken.updateSeriesMetadataURI(tokenId, metadataURI);
    }

    function buy(
        uint256 tokenId,
        address paymentToken,
        uint256 quantity,
        uint256 maxCost,
        address beneficiary
    ) external nonReentrant seriesExists(tokenId) {
        if (beneficiary == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        Series storage series = _seriesById[tokenId];
        _enforceSaleOpen(series);

        uint256 unitPrice = unitPriceByPaymentToken[tokenId][paymentToken];
        if (!paymentTokenEnabled[tokenId][paymentToken] || unitPrice == 0) {
            revert WeBlockErrors.UnsupportedPaymentToken();
        }
        if (quantity == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }
        if (uint256(series.soldSupply) + quantity > series.maxSupply) {
            revert WeBlockErrors.QuantityTooHigh();
        }

        uint256 totalCost = unitPrice * quantity;
        if (totalCost > maxCost) {
            revert WeBlockErrors.PriceSlippage();
        }

        IERC20(paymentToken).safeTransferFrom(
            msg.sender,
            address(this),
            totalCost
        );
        escrowedByPaymentToken[tokenId][paymentToken] += totalCost;
        contributedByAccount[tokenId][beneficiary][paymentToken] += totalCost;
        series.soldSupply += uint128(quantity);

        rbtToken.mint(beneficiary, tokenId, quantity, "");
        emit SalePurchase(
            tokenId,
            msg.sender,
            beneficiary,
            paymentToken,
            quantity,
            totalCost
        );

        if (series.soldSupply == series.maxSupply) {
            _finalizeSale(tokenId);
        }
    }

    function finalizeSale(
        uint256 tokenId
    )
        external
        nonReentrant
        onlyRole(WeBlockRoles.OPERATOR_ROLE)
        seriesExists(tokenId)
    {
        Series storage series = _seriesById[tokenId];
        if (series.state != SeriesState.Sale) {
            revert WeBlockErrors.InvalidStateTransition();
        }
        if (
            block.timestamp < series.saleEnd &&
            series.soldSupply != series.maxSupply
        ) {
            revert WeBlockErrors.SaleNotEnded();
        }

        _finalizeSale(tokenId);
    }

    function cancelSale(
        uint256 tokenId,
        string calldata memo
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        Series storage series = _seriesById[tokenId];
        if (
            series.state != SeriesState.Draft &&
            series.state != SeriesState.Sale
        ) {
            revert WeBlockErrors.InvalidStateTransition();
        }

        series.state = SeriesState.Cancelled;
        series.cancellationMemo = memo;
        emit SaleCancelled(tokenId, memo);
    }

    function claimRefund(
        uint256 tokenId
    ) external nonReentrant seriesExists(tokenId) {
        Series storage series = _seriesById[tokenId];
        if (series.state != SeriesState.Cancelled) {
            revert WeBlockErrors.RefundNotAvailable();
        }

        uint256 balance = rbtToken.balanceOf(msg.sender, tokenId);
        if (balance == 0) {
            revert WeBlockErrors.RefundNotAvailable();
        }

        rbtToken.burn(msg.sender, tokenId, balance);

        address[] storage paymentTokens = _paymentTokensBySeries[tokenId];
        uint256 refunded;
        for (uint256 i = 0; i < paymentTokens.length; i++) {
            address paymentToken = paymentTokens[i];
            uint256 amount = contributedByAccount[tokenId][msg.sender][
                paymentToken
            ];
            if (amount == 0) {
                continue;
            }

            contributedByAccount[tokenId][msg.sender][paymentToken] = 0;
            escrowedByPaymentToken[tokenId][paymentToken] -= amount;
            IERC20(paymentToken).safeTransfer(msg.sender, amount);
            refunded += amount;
            emit RefundClaimed(tokenId, msg.sender, paymentToken, amount);
        }

        if (refunded == 0) {
            revert WeBlockErrors.RefundNotAvailable();
        }
    }

    function fundInterest(
        uint256 tokenId,
        address paymentToken,
        uint256 amount
    )
        external
        nonReentrant
        onlyRole(WeBlockRoles.TREASURY_FUNDER_ROLE)
        seriesExists(tokenId)
    {
        SeriesState state = _seriesById[tokenId].state;
        if (state != SeriesState.Active && state != SeriesState.Delinquent) {
            revert WeBlockErrors.UnsupportedSeriesState();
        }
        if (!paymentTokenEnabled[tokenId][paymentToken]) {
            revert WeBlockErrors.UnsupportedPaymentToken();
        }

        uint256 currentSupply = rbtToken.totalSupply(tokenId);
        if (currentSupply == 0 || amount == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }

        interestRouter.fundFrom(paymentToken, msg.sender, amount);
        accInterestPerShare[tokenId][paymentToken] +=
            (amount * ACCURACY) / currentSupply;
        emit InterestFunded(
            tokenId,
            paymentToken,
            amount,
            accInterestPerShare[tokenId][paymentToken]
        );
    }

    function claimInterest(
        uint256 tokenId,
        address paymentToken
    ) external nonReentrant seriesExists(tokenId) {
        _settleAccount(msg.sender, tokenId);

        uint256 amount = pendingInterest[msg.sender][tokenId][paymentToken];
        if (amount == 0) {
            revert WeBlockErrors.ClaimNothingDue();
        }

        pendingInterest[msg.sender][tokenId][paymentToken] = 0;
        interestRouter.payout(paymentToken, msg.sender, amount);
        emit InterestClaimed(tokenId, msg.sender, paymentToken, amount);
    }

    function claimInterestBatch(
        uint256 tokenId,
        address[] calldata paymentTokens
    ) external nonReentrant seriesExists(tokenId) {
        _settleAccount(msg.sender, tokenId);

        uint256 claimed;
        for (uint256 i = 0; i < paymentTokens.length; i++) {
            uint256 amount = pendingInterest[msg.sender][tokenId][
                paymentTokens[i]
            ];
            if (amount == 0) {
                continue;
            }

            pendingInterest[msg.sender][tokenId][paymentTokens[i]] = 0;
            interestRouter.payout(paymentTokens[i], msg.sender, amount);
            emit InterestClaimed(tokenId, msg.sender, paymentTokens[i], amount);
            claimed += amount;
        }

        if (claimed == 0) {
            revert WeBlockErrors.ClaimNothingDue();
        }
    }

    function markDelinquent(
        uint256 tokenId,
        string calldata memo
    )
        external
        onlyRole(WeBlockRoles.DELINQUENCY_MANAGER_ROLE)
        seriesExists(tokenId)
    {
        Series storage series = _seriesById[tokenId];
        if (series.state != SeriesState.Active) {
            revert WeBlockErrors.InvalidStateTransition();
        }

        series.state = SeriesState.Delinquent;
        series.delinquencyMemo = memo;
        emit SeriesDelinquent(tokenId, memo);
    }

    function cureDelinquency(
        uint256 tokenId
    )
        external
        onlyRole(WeBlockRoles.DELINQUENCY_MANAGER_ROLE)
        seriesExists(tokenId)
    {
        Series storage series = _seriesById[tokenId];
        if (series.state != SeriesState.Delinquent) {
            revert WeBlockErrors.InvalidStateTransition();
        }

        series.state = SeriesState.Active;
        emit SeriesDelinquencyCured(tokenId);
    }

    function declareDefault(
        uint256 tokenId,
        string calldata memo
    )
        external
        onlyRole(WeBlockRoles.DELINQUENCY_MANAGER_ROLE)
        seriesExists(tokenId)
    {
        Series storage series = _seriesById[tokenId];
        if (
            series.state != SeriesState.Active &&
            series.state != SeriesState.Delinquent
        ) {
            revert WeBlockErrors.InvalidStateTransition();
        }

        series.state = SeriesState.Defaulted;
        series.defaultMemo = memo;
        emit SeriesDefaulted(tokenId, memo);
    }

    function enterMaturity(
        uint256 tokenId
    ) external onlyRole(WeBlockRoles.OPERATOR_ROLE) seriesExists(tokenId) {
        Series storage series = _seriesById[tokenId];
        if (
            series.state != SeriesState.Active &&
            series.state != SeriesState.Delinquent &&
            series.state != SeriesState.Defaulted
        ) {
            revert WeBlockErrors.InvalidStateTransition();
        }
        if (
            series.state != SeriesState.Defaulted &&
            block.timestamp < series.maturityDate
        ) {
            revert WeBlockErrors.MaturityNotReached();
        }

        series.state = SeriesState.Matured;
        emit SeriesMatured(tokenId, block.timestamp);
    }

    function enableRedemption(
        uint256 tokenId,
        address paymentToken,
        uint256 totalAmount
    )
        external
        nonReentrant
        onlyRole(WeBlockRoles.TREASURY_FUNDER_ROLE)
        seriesExists(tokenId)
    {
        SeriesState state = _seriesById[tokenId].state;
        if (state != SeriesState.Matured && state != SeriesState.Defaulted) {
            revert WeBlockErrors.InvalidStateTransition();
        }
        if (redemptionEnabled[tokenId][paymentToken]) {
            revert WeBlockErrors.InvalidStateTransition();
        }
        if (totalAmount == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }

        uint256 supplySnapshot = rbtToken.totalSupply(tokenId);
        if (supplySnapshot == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }

        redemptionRouter.fundFrom(paymentToken, msg.sender, totalAmount);
        redemptionEnabled[tokenId][paymentToken] = true;
        redemptionSupplySnapshot[tokenId][paymentToken] = supplySnapshot;
        redemptionPerToken[tokenId][paymentToken] =
            (totalAmount * ACCURACY) / supplySnapshot;

        emit RedemptionEnabled(
            tokenId,
            paymentToken,
            totalAmount,
            redemptionPerToken[tokenId][paymentToken]
        );
    }

    function redeem(
        uint256 tokenId,
        address paymentToken,
        uint256 quantity
    ) external nonReentrant seriesExists(tokenId) {
        if (!redemptionEnabled[tokenId][paymentToken]) {
            revert WeBlockErrors.RedemptionNotEnabled();
        }
        if (quantity == 0) {
            revert WeBlockErrors.QuantityTooLow();
        }

        uint256 payout =
            (quantity * redemptionPerToken[tokenId][paymentToken]) / ACCURACY;
        rbtToken.burn(msg.sender, tokenId, quantity);
        redemptionRouter.payout(paymentToken, msg.sender, payout);
        emit Redeemed(tokenId, msg.sender, paymentToken, quantity, payout);
    }

    function beforeTokenTransfer(
        address,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata
    ) external override {
        if (msg.sender != address(rbtToken)) {
            revert WeBlockErrors.UnauthorizedCaller();
        }

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            if (
                from != address(0) &&
                to != address(0) &&
                !isSeriesActiveForTrading(tokenId)
            ) {
                revert WeBlockErrors.TransferNotAllowed();
            }

            if (from != address(0)) {
                _settleAccount(from, tokenId);
            }
            if (to != address(0) && to != from) {
                _settleAccount(to, tokenId);
            }
        }
    }

    function afterTokenTransfer(
        address,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata
    ) external override {
        if (msg.sender != address(rbtToken)) {
            revert WeBlockErrors.UnauthorizedCaller();
        }

        for (uint256 i = 0; i < ids.length; i++) {
            uint256 tokenId = ids[i];
            if (from != address(0)) {
                _resetDebt(from, tokenId);
            }
            if (to != address(0) && to != from) {
                _resetDebt(to, tokenId);
            }
        }
    }

    function seriesPaymentTokens(
        uint256 tokenId
    ) external view returns (address[] memory) {
        return _paymentTokensBySeries[tokenId];
    }

    function getSeries(uint256 tokenId) external view returns (Series memory) {
        return _seriesById[tokenId];
    }

    function isSeriesActiveForTrading(
        uint256 tokenId
    ) public view returns (bool) {
        Series storage series = _seriesById[tokenId];
        return
            series.state == SeriesState.Active &&
            series.secondaryTradingEnabled;
    }

    function quotePrimarySale(
        uint256 tokenId,
        address paymentToken,
        uint256 quantity
    ) external view returns (uint256) {
        return unitPriceByPaymentToken[tokenId][paymentToken] * quantity;
    }

    function _configurePaymentTokens(
        uint256 tokenId,
        address[] calldata paymentTokens,
        uint256[] calldata unitPrices
    ) private {
        if (paymentTokens.length != unitPrices.length) {
            revert WeBlockErrors.InvalidArrayLength();
        }

        for (uint256 i = 0; i < paymentTokens.length; i++) {
            address paymentToken = paymentTokens[i];
            if (paymentToken == address(0)) {
                revert WeBlockErrors.ZeroAddress();
            }

            if (!paymentTokenEnabled[tokenId][paymentToken]) {
                _paymentTokensBySeries[tokenId].push(paymentToken);
                paymentTokenEnabled[tokenId][paymentToken] = true;
            }
            unitPriceByPaymentToken[tokenId][paymentToken] = unitPrices[i];
            emit PaymentTokenConfigured(
                tokenId,
                paymentToken,
                unitPrices[i],
                true
            );
        }
    }

    function _enforceSaleOpen(Series storage series) private view {
        if (series.state != SeriesState.Sale) {
            revert WeBlockErrors.SaleNotOpen();
        }
        if (
            block.timestamp < series.saleStart ||
            block.timestamp > series.saleEnd
        ) {
            revert WeBlockErrors.SaleNotOpen();
        }
    }

    function _finalizeSale(uint256 tokenId) private {
        Series storage series = _seriesById[tokenId];
        series.state = SeriesState.Active;
        series.activatedAt = uint64(block.timestamp);

        address[] storage paymentTokens_ = _paymentTokensBySeries[tokenId];
        for (uint256 i = 0; i < paymentTokens_.length; i++) {
            address paymentToken = paymentTokens_[i];
            uint256 escrowed = escrowedByPaymentToken[tokenId][paymentToken];
            if (escrowed == 0) {
                continue;
            }

            escrowedByPaymentToken[tokenId][paymentToken] = 0;
            IERC20(paymentToken).safeTransfer(series.issuerTreasury, escrowed);
        }

        emit SaleFinalized(tokenId, series.soldSupply, series.activatedAt);
    }

    function _settleAccount(address account, uint256 tokenId) private {
        address[] storage paymentTokens_ = _paymentTokensBySeries[tokenId];
        uint256 balance = rbtToken.balanceOf(account, tokenId);

        for (uint256 i = 0; i < paymentTokens_.length; i++) {
            address paymentToken = paymentTokens_[i];
            uint256 accumulated =
                (balance * accInterestPerShare[tokenId][paymentToken]) /
                    ACCURACY;
            uint256 debt = interestDebt[account][tokenId][paymentToken];
            if (accumulated > debt) {
                pendingInterest[account][tokenId][paymentToken] +=
                    accumulated - debt;
            }
            interestDebt[account][tokenId][paymentToken] = accumulated;
        }
    }

    function _resetDebt(address account, uint256 tokenId) private {
        address[] storage paymentTokens_ = _paymentTokensBySeries[tokenId];
        uint256 balance = rbtToken.balanceOf(account, tokenId);

        for (uint256 i = 0; i < paymentTokens_.length; i++) {
            address paymentToken = paymentTokens_[i];
            interestDebt[account][tokenId][paymentToken] =
                (balance * accInterestPerShare[tokenId][paymentToken]) /
                ACCURACY;
        }
    }
}
