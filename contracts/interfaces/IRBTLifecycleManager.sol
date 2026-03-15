// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IRBTLifecycleManager {
    function beforeTokenTransfer(
        address operator,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values
    ) external;

    function afterTokenTransfer(
        address operator,
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata values
    ) external;
}
