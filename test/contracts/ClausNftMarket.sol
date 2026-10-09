// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IClausMarketCollection is IERC721 {
    function transferNonce(uint256 id) external view returns (uint256);
}

/// @notice Fixed-price native ETH sales for one collection. Seller keeps custody until sale.
contract ClausNftMarket is ReentrancyGuard {
    struct Listing { address seller; uint256 price; uint256 transferNonce; uint256 revision; }
    IClausMarketCollection public immutable collection;
    address public immutable feeRecipient;
    uint256 public constant FEE_BPS = 200;
    mapping(uint256 => Listing) public listings;
    mapping(address => uint256) public deferredProceeds;
    error InvalidOrder();
    error PaymentFailed();
    event Listed(uint256 indexed id, address indexed seller, uint256 price, uint256 revision);
    event Cancelled(uint256 indexed id, uint256 revision);
    event Sold(uint256 indexed id, address indexed seller, address indexed buyer, uint256 price, uint256 fee);
    event ProceedsDeferred(address indexed account, uint256 amount);

    constructor(IClausMarketCollection collection_, address recipient_) {
        require(address(collection_).code.length != 0 && recipient_ != address(0), "market config");
        collection = collection_; feeRecipient = recipient_;
    }

    function list(uint256 id, uint256 price) external {
        if (price == 0 || collection.ownerOf(id) != msg.sender) revert InvalidOrder();
        if (collection.getApproved(id) != address(this) && !collection.isApprovedForAll(msg.sender, address(this))) revert InvalidOrder();
        uint256 revision = listings[id].revision + 1;
        listings[id] = Listing(msg.sender, price, collection.transferNonce(id), revision);
        emit Listed(id, msg.sender, price, revision);
    }

    function cancel(uint256 id) external {
        Listing storage order = listings[id];
        if (order.seller != msg.sender) revert InvalidOrder();
        order.price = 0; ++order.revision;
        emit Cancelled(id, order.revision);
    }

    function isActive(uint256 id) external view returns (bool) {
        Listing memory order = listings[id];
        if (order.price == 0) return false;
        try collection.ownerOf(id) returns (address who) {
            return who == order.seller && collection.transferNonce(id) == order.transferNonce
                && (collection.getApproved(id) == address(this) || collection.isApprovedForAll(who, address(this)));
        } catch { return false; }
    }

    function buy(uint256 id, uint256 expectedRevision, address expectedSeller) external payable nonReentrant {
        Listing memory order = listings[id];
        if (order.price == 0 || msg.value != order.price || order.revision != expectedRevision || order.seller != expectedSeller
            || collection.transferNonce(id) != order.transferNonce || collection.ownerOf(id) != order.seller) revert InvalidOrder();
        listings[id].price = 0; ++listings[id].revision;
        collection.safeTransferFrom(order.seller, msg.sender, id);
        uint256 fee = msg.value * FEE_BPS / 10_000;
        _sendOrCredit(feeRecipient, fee);
        _sendOrCredit(order.seller, msg.value - fee);
        emit Sold(id, order.seller, msg.sender, msg.value, fee);
    }

    function _sendOrCredit(address account, uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = payable(account).call{value: amount, gas: 60_000}("");
        if (!ok) { deferredProceeds[account] += amount; emit ProceedsDeferred(account, amount); }
    }

    /// @notice Failed contract-wallet payments stay withdrawable by that wallet.
    function withdrawProceeds(address payable recipient) external nonReentrant {
        uint256 amount = deferredProceeds[msg.sender];
        if (amount == 0 || recipient == address(0)) revert InvalidOrder();
        deferredProceeds[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}("");
        if (!ok) revert PaymentFailed();
    }
}
