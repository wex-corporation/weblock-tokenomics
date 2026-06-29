// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {ERC1155Pausable} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";
import {IRBTGate} from "../interfaces/IRBTGate.sol";

/// @title RBT — Real Estate Backed Token
/// @notice ERC-1155 where each `id` is one property series ("a slice of a building").
///         Minted/burned only by the SeriesManager (MANAGER_ROLE). Secondary transfers pass
///         through a KYC/series-state gate; mint (sale) and burn (redemption) bypass the
///         secondary gate, and registered operator contracts (escrow) are exempt.
contract RBT is ERC1155, ERC1155Supply, ERC1155Pausable, AccessControl {
    string public constant name = "WeBlock Real Estate Backed Token";
    string public constant symbol = "RBT";

    IRBTGate public gate;
    mapping(address => bool) public gateExempt; // operator contracts whose flows bypass the secondary gate
    mapping(uint256 => string) private _tokenURIs;

    event GateUpdated(address indexed gate);
    event GateExemptSet(address indexed account, bool exempt);
    event TokenURISet(uint256 indexed id, string uri);

    constructor(address admin, string memory baseUri) ERC1155(baseUri) {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.URI_MANAGER_ROLE, admin);
        _grantRole(Roles.PAUSER_ROLE, admin);
    }

    // --- admin wiring ---
    function setGate(address g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        gate = IRBTGate(g);
        emit GateUpdated(g);
    }

    function setGateExempt(address account, bool exempt) external onlyRole(DEFAULT_ADMIN_ROLE) {
        gateExempt[account] = exempt;
        emit GateExemptSet(account, exempt);
    }

    function setTokenURI(uint256 id, string calldata u) external onlyRole(Roles.URI_MANAGER_ROLE) {
        _tokenURIs[id] = u;
        emit TokenURISet(id, u);
    }

    function pause() external onlyRole(Roles.PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(Roles.PAUSER_ROLE) {
        _unpause();
    }

    // --- manager mint/burn (SeriesManager) ---
    function mint(address to, uint256 id, uint256 amount) external onlyRole(Roles.MANAGER_ROLE) {
        _mint(to, id, amount, "");
    }

    function burn(address from, uint256 id, uint256 amount) external onlyRole(Roles.MANAGER_ROLE) {
        _burn(from, id, amount);
    }

    function uri(uint256 id) public view override returns (string memory) {
        string memory u = _tokenURIs[id];
        return bytes(u).length > 0 ? u : super.uri(id);
    }

    function _update(address from, address to, uint256[] memory ids, uint256[] memory values)
        internal
        override(ERC1155, ERC1155Supply, ERC1155Pausable)
    {
        // Gate only secondary transfers (not mint/burn) and not operator-exempt escrow flows.
        if (from != address(0) && to != address(0) && address(gate) != address(0)) {
            address operator = _msgSender();
            if (!gateExempt[operator] && !gateExempt[from] && !gateExempt[to]) {
                for (uint256 i; i < ids.length; ++i) {
                    gate.checkTransfer(operator, from, to, ids[i], values[i]);
                }
            }
        }
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
