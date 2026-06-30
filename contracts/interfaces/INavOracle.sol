// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface INavOracle {
    function markPrice(uint256 marketId) external view returns (uint256);

    /// @return price last published price (0 if none); fresh true if within the staleness window
    function peekPrice(uint256 marketId) external view returns (uint256 price, bool fresh);
}
