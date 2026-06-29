// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Errors} from "../libraries/Errors.sol";
import {WFT} from "../tokens/WFT.sol";

/// @title WftClaim
/// @notice TGE claim of WFT from a WBP snapshot. Allocation = (myWBP / totalEligibleWBP) × seasonPool,
///         computed off-chain (discretionary, no fixed rate). Two vesting tracks: immediate (100%)
///         and whale (50% now + 50% locked until `vestingUnlockAt`).
/// @dev PAUSED at deploy; enabled only after legal sign-off. Requires WFT MINTER_ROLE + LOCK_MANAGER_ROLE,
///      granted at enable time. Leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount, track)))).
contract WftClaim is AccessControl, ReentrancyGuard, Pausable {
    WFT public immutable wft;
    bytes32 public merkleRoot;
    uint64 public vestingUnlockAt;

    mapping(address => bool) public claimed;

    event Configured(bytes32 merkleRoot, uint64 vestingUnlockAt);
    event Claimed(address indexed account, uint256 amount, uint8 track);

    constructor(address admin, address wft_) {
        if (admin == address(0) || wft_ == address(0)) revert Errors.ZeroAddress();
        wft = WFT(wft_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _pause(); // legal gate: disabled until explicitly enabled
    }

    function configure(bytes32 merkleRoot_, uint64 vestingUnlockAt_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        merkleRoot = merkleRoot_;
        vestingUnlockAt = vestingUnlockAt_;
        emit Configured(merkleRoot_, vestingUnlockAt_);
    }

    function enable() external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (merkleRoot == bytes32(0)) revert Errors.InvalidState();
        _unpause();
    }

    function disable() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    /// @param track 0 = immediate (100%), 1 = whale (50% now + 50% locked)
    function claim(uint256 amount, uint8 track, bytes32[] calldata proof) external nonReentrant whenNotPaused {
        if (claimed[msg.sender]) revert Errors.AlreadyClaimed();
        if (amount == 0) revert Errors.ZeroAmount();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount, track))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert Errors.InvalidProof();

        claimed[msg.sender] = true;
        if (track == 0) {
            wft.mint(msg.sender, amount);
        } else {
            uint256 half = amount / 2;
            wft.mint(msg.sender, half);
            wft.mintLocked(msg.sender, amount - half, vestingUnlockAt, false);
        }
        emit Claimed(msg.sender, amount, track);
    }
}
