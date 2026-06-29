// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IInsuranceFund {
    function cover(address to, uint256 amount) external returns (uint256 paid);
}
