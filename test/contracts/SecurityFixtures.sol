// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";

interface ISecurityTreasury {
    function buyNFT(uint256 id, address recipient) external payable;
    function accountSurplus() external;
}

/// @dev Tests cross-function callbacks from an NFT buyer, not a production component.
contract ReentrantNFTBuyer is IERC721Receiver {
    address public immutable treasury;
    uint256 public callbacks;
    uint256 public unexpectedSuccesses;
    bool public rejectNFT;

    constructor(address treasury_) { treasury = treasury_; }

    function configure(bool reject_) external { rejectNFT = reject_; }

    function buy(uint256 id) external payable {
        ISecurityTreasury(treasury).buyNFT{value: msg.value}(id, address(this));
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external returns (bytes4) {
        ++callbacks;
        // This unguarded accounting function is intentionally callable during the sale.
        // It must not double count the current payment or corrupt the other ledger.
        ISecurityTreasury(treasury).accountSurplus();
        (bool buySucceeded,) = treasury.call(abi.encodeWithSignature("buyNFT(uint256,address)", id, address(this)));
        (bool purchaseSucceeded,) = treasury.call(abi.encodeWithSignature("purchaseCheapest(uint256,uint256)", 0, 0));
        (bool buybackSucceeded,) = treasury.call(abi.encodeWithSignature("executeBuyback()"));
        if (buySucceeded) unexpectedSuccesses |= 1;
        if (purchaseSucceeded) unexpectedSuccesses |= 2;
        if (buybackSucceeded) unexpectedSuccesses |= 4;
        require(!rejectNFT, "Recipient refused NFT");
        return IERC721Receiver.onERC721Received.selector;
    }
}
