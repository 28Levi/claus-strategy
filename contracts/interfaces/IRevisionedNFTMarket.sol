// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Compatible with the deployed ClausNftMarket and StrategyOfferMarket.
interface IRevisionedNFTMarket {
    function collection() external view returns (address);
    function listings(uint256 id) external view returns (address seller, uint256 price, uint256 transferNonce, uint256 revision);
    function isActive(uint256 id) external view returns (bool);
    function buy(uint256 id, uint256 expectedRevision, address expectedSeller) external payable;
}
