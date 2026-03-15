// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {WeBlockErrors} from "../shared/WeBlockErrors.sol";

contract PaymentVault {
    using SafeERC20 for IERC20;

    address public immutable router;
    IERC20 public immutable asset;

    event Payout(address indexed to, uint256 amount);
    event Swept(address indexed to, uint256 amount);

    modifier onlyRouter() {
        if (msg.sender != router) {
            revert WeBlockErrors.UnauthorizedCaller();
        }
        _;
    }

    constructor(address router_, address asset_) {
        if (router_ == address(0) || asset_ == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        router = router_;
        asset = IERC20(asset_);
    }

    function balance() external view returns (uint256) {
        return asset.balanceOf(address(this));
    }

    function payout(address to, uint256 amount) external onlyRouter {
        if (to == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        asset.safeTransfer(to, amount);
        emit Payout(to, amount);
    }

    function sweep(address to, uint256 amount) external onlyRouter {
        if (to == address(0)) {
            revert WeBlockErrors.ZeroAddress();
        }

        asset.safeTransfer(to, amount);
        emit Swept(to, amount);
    }
}
