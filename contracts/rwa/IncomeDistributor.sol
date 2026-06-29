// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Roles} from "../access/Roles.sol";
import {Errors} from "../libraries/Errors.sol";

/// @title IncomeDistributor
/// @notice Monthly rental-income distribution via Merkle proofs (the core-loop payout). The backend
///         snapshots RBT holders at month-end, computes pro-rata (holding-days weighted) amounts,
///         builds a Merkle root, opens a round (depositing the pool), and users claim with a proof.
///         "Compound" (reinvest, +25% points) is an application-layer flow: claim then re-invest;
///         the backend awards the bonus on observing it.
/// @dev Leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount)))) — double-hash,
///      second-preimage safe, identical to the backend MerkleTree implementation.
contract IncomeDistributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Round {
        address token;
        bytes32 merkleRoot;
        uint256 totalPool;
        uint256 claimed;
        uint64 periodYYYYMM;
        bool exists;
    }

    mapping(uint256 => Round) public rounds; // roundId => Round
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    event RoundOpened(uint256 indexed roundId, address token, bytes32 merkleRoot, uint256 totalPool, uint64 periodYYYYMM);
    event Claimed(uint256 indexed roundId, address indexed account, uint256 amount);
    event Swept(uint256 indexed roundId, address to, uint256 amount);

    constructor(address admin) {
        if (admin == address(0)) revert Errors.ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(Roles.DISTRIBUTION_MANAGER_ROLE, admin);
    }

    function openRound(uint256 roundId, address token, bytes32 merkleRoot, uint256 totalPool, uint64 periodYYYYMM)
        external
        onlyRole(Roles.DISTRIBUTION_MANAGER_ROLE)
        nonReentrant
    {
        if (rounds[roundId].exists) revert Errors.RoundExists(roundId);
        if (token == address(0)) revert Errors.ZeroAddress();
        if (merkleRoot == bytes32(0) || totalPool == 0) revert Errors.ZeroAmount();

        rounds[roundId] = Round(token, merkleRoot, totalPool, 0, periodYYYYMM, true);
        IERC20(token).safeTransferFrom(msg.sender, address(this), totalPool);
        emit RoundOpened(roundId, token, merkleRoot, totalPool, periodYYYYMM);
    }

    function claim(uint256 roundId, uint256 amount, bytes32[] calldata proof) external nonReentrant {
        Round storage r = rounds[roundId];
        if (!r.exists) revert Errors.RoundNotFound(roundId);
        if (hasClaimed[roundId][msg.sender]) revert Errors.AlreadyClaimed();
        if (amount == 0) revert Errors.ZeroAmount();

        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, amount))));
        if (!MerkleProof.verify(proof, r.merkleRoot, leaf)) revert Errors.InvalidProof();

        hasClaimed[roundId][msg.sender] = true;
        r.claimed += amount;
        IERC20(r.token).safeTransfer(msg.sender, amount);
        emit Claimed(roundId, msg.sender, amount);
    }

    function isClaimable(uint256 roundId, address account, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Round storage r = rounds[roundId];
        if (!r.exists || hasClaimed[roundId][account]) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        return MerkleProof.verify(proof, r.merkleRoot, leaf);
    }

    /// @notice Recover unclaimed dust/residual from a round (e.g. after a claim deadline).
    function sweep(uint256 roundId, address to) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        Round storage r = rounds[roundId];
        if (!r.exists) revert Errors.RoundNotFound(roundId);
        if (to == address(0)) revert Errors.ZeroAddress();
        uint256 remaining = r.totalPool - r.claimed;
        if (remaining == 0) revert Errors.ZeroAmount();
        r.claimed = r.totalPool;
        IERC20(r.token).safeTransfer(to, remaining);
        emit Swept(roundId, to, remaining);
    }
}
