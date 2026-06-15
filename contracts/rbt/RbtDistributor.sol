// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title RbtDistributor
 * @notice Merkle-based monthly rental-income distributor (backend B1 settlement). A manager opens a
 *         round funded with a stablecoin pool and a merkle root over per-holder claims computed
 *         off-chain by `IncomeDistributionService` / `MerkleTree`. Holders claim with a proof.
 * @dev Leaf = keccak256(bytes.concat(keccak256(abi.encodePacked(account, amount)))) — double-hashed
 *      to match the off-chain generator and guard against second-preimage attacks. Proofs use
 *      OZ MerkleProof (sorted, commutative pairs). Pre-audit; testnet only.
 */
contract RbtDistributor is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant DISTRIBUTION_MANAGER_ROLE =
        keccak256("DISTRIBUTION_MANAGER_ROLE");

    struct Round {
        IERC20 token;
        bytes32 merkleRoot;
        uint256 total;
        uint256 claimed;
        bool exists;
    }

    mapping(uint256 => Round) public rounds;
    mapping(uint256 => mapping(address => bool)) public hasClaimed;

    error RoundExists();
    error RoundMissing();
    error AlreadyClaimed();
    error InvalidProof();
    error ZeroParams();

    event RoundCreated(
        uint256 indexed roundId,
        address indexed token,
        bytes32 merkleRoot,
        uint256 total
    );
    event Claimed(
        uint256 indexed roundId,
        address indexed account,
        uint256 amount
    );

    constructor(address admin) {
        if (admin == address(0)) revert ZeroParams();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISTRIBUTION_MANAGER_ROLE, admin);
    }

    /**
     * @notice Open a funded distribution round. Pulls `total` of `token` from the caller, who must
     *         have approved this contract.
     */
    function createRound(
        uint256 roundId,
        IERC20 token,
        bytes32 merkleRoot,
        uint256 total
    ) external onlyRole(DISTRIBUTION_MANAGER_ROLE) nonReentrant {
        if (rounds[roundId].exists) revert RoundExists();
        if (address(token) == address(0) || merkleRoot == bytes32(0) || total == 0) {
            revert ZeroParams();
        }
        rounds[roundId] = Round({
            token: token,
            merkleRoot: merkleRoot,
            total: total,
            claimed: 0,
            exists: true
        });
        token.safeTransferFrom(msg.sender, address(this), total);
        emit RoundCreated(roundId, address(token), merkleRoot, total);
    }

    /// @notice Claim `amount` for `msg.sender` in `roundId` using a merkle `proof`.
    function claim(
        uint256 roundId,
        uint256 amount,
        bytes32[] calldata proof
    ) external nonReentrant {
        Round storage round = rounds[roundId];
        if (!round.exists) revert RoundMissing();
        if (hasClaimed[roundId][msg.sender]) revert AlreadyClaimed();

        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encodePacked(msg.sender, amount)))
        );
        if (!MerkleProof.verify(proof, round.merkleRoot, leaf)) {
            revert InvalidProof();
        }

        hasClaimed[roundId][msg.sender] = true;
        round.claimed += amount;
        round.token.safeTransfer(msg.sender, amount);
        emit Claimed(roundId, msg.sender, amount);
    }

    /// @notice Verify a claim without spending gas to submit it (read helper for the frontend).
    function verify(
        uint256 roundId,
        address account,
        uint256 amount,
        bytes32[] calldata proof
    ) external view returns (bool) {
        Round storage round = rounds[roundId];
        if (!round.exists) return false;
        bytes32 leaf = keccak256(
            bytes.concat(keccak256(abi.encodePacked(account, amount)))
        );
        return MerkleProof.verify(proof, round.merkleRoot, leaf);
    }
}
