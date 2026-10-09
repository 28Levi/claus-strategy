// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice An immutable executor that spends the supplied ETH and delivers tokens to its treasury.
interface IStrategyBuyback {
    function executeBuyback() external payable returns (uint256 amountOut);
    function minimumBuybackOut(uint256 amountIn) external view returns (uint256 amountOut);
}
