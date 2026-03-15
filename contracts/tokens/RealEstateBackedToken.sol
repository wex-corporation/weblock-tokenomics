// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IRBTLifecycleManager} from "../interfaces/IRBTLifecycleManager.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";
import {WeBlockRoles} from "../shared/WeBlockRoles.sol";

contract RealEstateBackedToken is
    ERC1155,
    ERC1155Supply,
    AccessControl,
    Pausable
{
    struct SeriesTokenData {
        string propertyCode;
        string propertyName;
        uint32 roundNumber;
        string roundLabel;
        string metadataURI;
    }

    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");

    IRBTLifecycleManager public lifecycleManager;
    mapping(uint256 => SeriesTokenData) private _seriesData;

    event LifecycleManagerSet(
        address indexed previousManager,
        address indexed newManager
    );
    event SeriesRegistered(
        uint256 indexed tokenId,
        string propertyCode,
        string propertyName,
        uint32 roundNumber,
        string roundLabel,
        string metadataURI
    );
    event SeriesMetadataUpdated(uint256 indexed tokenId, string metadataURI);

    constructor(address admin, string memory fallbackUri) ERC1155(fallbackUri) {
        if (admin == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(MANAGER_ROLE, admin);
        _grantRole(WeBlockRoles.URI_MANAGER_ROLE, admin);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    function setLifecycleManager(
        address newManager
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        emit LifecycleManagerSet(address(lifecycleManager), newManager);
        lifecycleManager = IRBTLifecycleManager(newManager);
    }

    function registerSeries(
        uint256 tokenId,
        string calldata propertyCode,
        string calldata propertyName,
        uint32 roundNumber,
        string calldata roundLabel,
        string calldata metadataURI
    ) external onlyRole(MANAGER_ROLE) {
        if (bytes(_seriesData[tokenId].propertyCode).length != 0) {
            revert WeBlockErrors.SeriesAlreadyExists();
        }

        _seriesData[tokenId] = SeriesTokenData({
            propertyCode: propertyCode,
            propertyName: propertyName,
            roundNumber: roundNumber,
            roundLabel: roundLabel,
            metadataURI: metadataURI
        });

        emit SeriesRegistered(
            tokenId,
            propertyCode,
            propertyName,
            roundNumber,
            roundLabel,
            metadataURI
        );
    }

    function updateSeriesMetadataURI(
        uint256 tokenId,
        string calldata metadataURI
    ) external onlyRole(WeBlockRoles.URI_MANAGER_ROLE) {
        if (bytes(_seriesData[tokenId].propertyCode).length == 0) {
            revert WeBlockErrors.SeriesNotFound();
        }

        _seriesData[tokenId].metadataURI = metadataURI;
        emit SeriesMetadataUpdated(tokenId, metadataURI);
    }

    function seriesData(
        uint256 tokenId
    ) external view returns (SeriesTokenData memory) {
        return _seriesData[tokenId];
    }

    function mint(
        address to,
        uint256 tokenId,
        uint256 amount,
        bytes calldata data
    ) external onlyRole(MANAGER_ROLE) {
        _mint(to, tokenId, amount, data);
    }

    function mintBatch(
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external onlyRole(MANAGER_ROLE) {
        _mintBatch(to, ids, amounts, data);
    }

    function burn(
        address from,
        uint256 tokenId,
        uint256 amount
    ) external onlyRole(MANAGER_ROLE) {
        _burn(from, tokenId, amount);
    }

    function burnBatch(
        address from,
        uint256[] calldata ids,
        uint256[] calldata amounts
    ) external onlyRole(MANAGER_ROLE) {
        _burnBatch(from, ids, amounts);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        string memory metadataURI = _seriesData[tokenId].metadataURI;
        if (bytes(metadataURI).length != 0) {
            return metadataURI;
        }
        return super.uri(tokenId);
    }

    function supportsInterface(
        bytes4 interfaceId
    ) public view override(ERC1155, AccessControl) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply) whenNotPaused {
        if (address(lifecycleManager) != address(0)) {
            lifecycleManager.beforeTokenTransfer(
                msg.sender,
                from,
                to,
                ids,
                values
            );
        }

        super._update(from, to, ids, values);

        if (address(lifecycleManager) != address(0)) {
            lifecycleManager.afterTokenTransfer(
                msg.sender,
                from,
                to,
                ids,
                values
            );
        }
    }
}
