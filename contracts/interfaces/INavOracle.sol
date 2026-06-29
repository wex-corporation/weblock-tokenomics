// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface INavOracle {
    function markPrice(uint256 marketId) external view returns (uint256);
}
