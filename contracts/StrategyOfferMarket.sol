// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Reusable, zero-fee fixed-price offer book for ordinary ERC721 collections.
/// @dev NFTs enter escrow using transferFrom; only their recorded seller may cancel.
/// Claus launches use the existing ClausNftMarket instead of this optional adapter.
contract StrategyOfferMarket is ReentrancyGuard {
    struct Listing { address seller; uint256 price; uint256 transferNonce; uint256 revision; }
    IERC721 public immutable collection;
    mapping(uint256 => Listing) public listings;
    mapping(address => uint256) public proceeds;
    event Listed(uint256 indexed id, address indexed seller, uint256 price, uint256 revision);
    event Sold(uint256 indexed id, address indexed buyer, uint256 price);
    event Cancelled(uint256 indexed id);

    constructor(IERC721 collection_) {
        require(address(collection_).code.length != 0, "Invalid collection");
        collection = collection_;
    }

    function list(uint256 id, uint256 price) external nonReentrant {
        require(price != 0 && collection.ownerOf(id) == msg.sender, "Invalid listing");
        Listing storage l = listings[id];
        require(l.seller == address(0), "Already listed");
        l.seller = msg.sender;
        l.price = price;
        l.revision++;
        collection.transferFrom(msg.sender, address(this), id);
        require(collection.ownerOf(id) == address(this), "Not escrowed");
        emit Listed(id, msg.sender, price, l.revision);
    }

    function cancel(uint256 id) external nonReentrant {
        Listing storage l = listings[id];
        require(l.seller == msg.sender, "Not seller");
        l.seller = address(0);
        l.price = 0;
        collection.safeTransferFrom(address(this), msg.sender, id);
        emit Cancelled(id);
    }

    function isActive(uint256 id) external view returns (bool) { return listings[id].seller != address(0); }

    function buy(uint256 id, uint256 expectedRevision, address expectedSeller) external payable nonReentrant {
        Listing storage l = listings[id];
        require(l.seller != address(0) && l.seller == expectedSeller && l.revision == expectedRevision
            && msg.value == l.price, "Stale listing or payment");
        address seller = l.seller;
        l.seller = address(0);
        l.price = 0;
        proceeds[seller] += msg.value;
        collection.safeTransferFrom(address(this), msg.sender, id);
        emit Sold(id, msg.sender, msg.value);
    }

    function withdrawProceeds(address payable recipient) external nonReentrant {
        uint256 amount = proceeds[msg.sender];
        proceeds[msg.sender] = 0;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "Payment failed");
    }
}
