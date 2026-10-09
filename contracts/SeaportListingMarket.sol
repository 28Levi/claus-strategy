// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SeaportInterface} from "seaport-types/src/interfaces/SeaportInterface.sol";
import {ConduitControllerInterface} from "seaport-types/src/interfaces/ConduitControllerInterface.sol";
import {ItemType, OrderType} from "seaport-types/src/lib/ConsiderationEnums.sol";
import {
    AdvancedOrder, Order, OrderParameters, OrderComponents, OfferItem,
    ConsiderationItem, CriteriaResolver
} from "seaport-types/src/lib/ConsiderationStructs.sol";

interface ISeaportStrategyPurchaser {
    function purchaseCheapest(uint256 expectedTokenId, uint256 expectedRevision) external;
}

/// @notice Immutable, native-ETH Seaport order adapter for one ERC721 collection.
/// @dev No approvals, custody, arbitrary calls, owner, or withdrawal endpoint. The
///      quote exists only during an atomic purchase. Order discovery and selection
///      happen off-chain: this adapter cannot prove OpenSea's complete order book.
///      Registration and purchase are atomic so any unfillable order rolls back.
///      The immutable purchase bot is trusted to choose a fair purchase price;
///      that authority does not permit withdrawing NFTs or changing these rules.
contract SeaportListingMarket is ReentrancyGuard {
    struct Listing { address seller; uint256 price; uint256 transferNonce; uint256 revision; }
    struct RegisteredOrder {
        bytes32 orderHash;
        uint256 startTime;
        uint256 endTime;
        address operator;
        bool usesConduit;
        bytes encodedOrder;
    }

    IERC721 public immutable collection;
    SeaportInterface public immutable seaport;
    ConduitControllerInterface public immutable conduitController;
    address public immutable allowedZone;
    address public immutable purchaseBot;

    uint256 public constant MAX_CONSIDERATION_ITEMS = 16;
    uint256 public constant MAX_SIGNATURE_BYTES = 4096;
    uint256 public constant MAX_EXTRA_DATA_BYTES = 8192;
    mapping(uint256 => Listing) public listings;
    mapping(uint256 => RegisteredOrder) private orders;
    bool private atomicPurchaseActive;

    error InvalidConfig();
    error UnsupportedOrder();
    error InactiveOrder();
    error CheaperOrderRegistered();
    error StaleQuote();
    error InvalidPayment();
    error InvalidFulfillment();
    error AtomicPurchaseRequired();
    error Unauthorized();

    event OrderRegistered(uint256 indexed id, address indexed seller, bytes32 indexed orderHash, uint256 price, uint256 revision);
    event OrderPurchased(uint256 indexed id, address indexed recipient, bytes32 indexed orderHash, uint256 price);

    constructor(IERC721 collection_, SeaportInterface seaport_, ConduitControllerInterface conduitController_, address allowedZone_, address purchaseBot_) {
        if (address(collection_).code.length == 0 || address(seaport_).code.length == 0
            || address(conduitController_).code.length == 0
            || purchaseBot_ == address(0)
            || (allowedZone_ != address(0) && allowedZone_.code.length == 0)) revert InvalidConfig();
        (string memory version,, address controller) = seaport_.information();
        if (controller != address(conduitController_) || keccak256(bytes(version)) != keccak256("1.6")) revert InvalidConfig();
        collection = collection_;
        seaport = seaport_;
        conduitController = conduitController_;
        allowedZone = allowedZone_;
        purchaseBot = purchaseBot_;
    }

    /// @notice Internal self-call used by the atomic purchase wrapper.
    /// @dev Seaport validates the maker's signature. Unsigned tips are rejected.
    ///      An active cheaper quote cannot be displaced with a higher-price order.
    function registerOrder(AdvancedOrder calldata order) external nonReentrant returns (uint256 revision) {
        OrderParameters calldata p = order.parameters;
        if (msg.sender != address(this) || !atomicPurchaseActive) revert AtomicPurchaseRequired();
        (uint256 id, uint256 price) = _checkOrder(order);
        uint256 counter = seaport.getCounter(p.offerer);
        bytes32 orderHash = seaport.getOrderHash(OrderComponents({
            offerer: p.offerer, zone: p.zone, offer: p.offer, consideration: p.consideration,
            orderType: p.orderType, startTime: p.startTime, endTime: p.endTime,
            zoneHash: p.zoneHash, salt: p.salt, conduitKey: p.conduitKey, counter: counter
        }));
        Listing storage listing = listings[id];
        if (isActive(id) && listing.price < price) revert CheaperOrderRegistered();
        Order[] memory validationOrders = new Order[](1);
        validationOrders[0] = Order(p, order.signature);
        if (!seaport.validate(validationOrders)) revert InactiveOrder();

        address operator = address(seaport);
        bool usesConduit = p.conduitKey != bytes32(0);
        if (usesConduit) {
            bool exists;
            (operator, exists) = conduitController.getConduit(p.conduitKey);
            if (!exists || operator.code.length == 0) revert InactiveOrder();
        }
        listing.seller = p.offerer;
        listing.price = price;
        listing.transferNonce = counter;
        revision = ++listing.revision;
        orders[id] = RegisteredOrder(orderHash, p.startTime, p.endTime, operator, usesConduit, abi.encode(order));
        if (!isActive(id)) revert InactiveOrder();
        emit OrderRegistered(id, p.offerer, orderHash, price, revision);
    }

    /// @notice The fixed purchase bot buys a listing atomically using treasury rules.
    /// @dev OpenSea zone fulfillment data must name this adapter as the fulfiller.
    ///      A failed purchase reverts registration too. Even an arbitrary target
    ///      cannot retain an unfillable quote: actual Seaport fill and NFT receipt
    ///      are checked before this wrapper returns.
    function registerAndPurchase(AdvancedOrder calldata order, address treasury) external {
        if (msg.sender != purchaseBot) revert Unauthorized();
        if (_reentrancyGuardEntered() || atomicPurchaseActive) revert ReentrancyGuardReentrantCall();
        if (treasury.code.length == 0 || treasury == address(this)) revert InvalidConfig();
        atomicPurchaseActive = true;
        uint256 id = order.parameters.offer.length == 1 ? order.parameters.offer[0].identifierOrCriteria : 0;
        uint256 revision = this.registerOrder(order);
        bytes32 orderHash = orders[id].orderHash;
        ISeaportStrategyPurchaser(treasury).purchaseCheapest(id, revision);
        if (listings[id].seller != address(0) || orders[id].orderHash != bytes32(0)
            || !_fullyFilled(orderHash) || collection.ownerOf(id) != treasury) revert InvalidFulfillment();
        atomicPurchaseActive = false;
    }

    function registeredOrderHash(uint256 id) external view returns (bytes32) { return orders[id].orderHash; }

    /// @notice Active means signed, live, unfilled, owned, and approved on-chain.
    /// @dev The quote exists only during registerAndPurchase; fulfillment verifies
    ///      zone authorization and consideration recipients accept their payments.
    function isActive(uint256 id) public view returns (bool) {
        Listing storage listing = listings[id];
        RegisteredOrder storage order = orders[id];
        if (listing.seller == address(0) || listing.price == 0 || block.timestamp < order.startTime
            || block.timestamp >= order.endTime || seaport.getCounter(listing.seller) != listing.transferNonce) return false;
        (bool validated, bool cancelled, uint256 filled,) = seaport.getOrderStatus(order.orderHash);
        if (!validated || cancelled || filled != 0) return false;
        try collection.ownerOf(id) returns (address owner) { if (owner != listing.seller) return false; }
        catch { return false; }
        if (order.usesConduit && !conduitController.getChannelStatus(order.operator, address(seaport))) return false;
        try collection.getApproved(id) returns (address approved) { if (approved == order.operator) return true; }
        catch { return false; }
        try collection.isApprovedForAll(listing.seller, order.operator) returns (bool approved) { return approved; }
        catch { return false; }
    }

    /// @notice Fill only the exact registered order and deliver directly to caller.
    function buy(uint256 id, uint256 expectedRevision, address expectedSeller) external payable nonReentrant {
        Listing storage listing = listings[id];
        if (listing.revision != expectedRevision || listing.seller != expectedSeller || !isActive(id)) revert StaleQuote();
        if (msg.value != listing.price) revert InvalidPayment();
        bytes32 orderHash = orders[id].orderHash;
        AdvancedOrder memory order = abi.decode(orders[id].encodedOrder, (AdvancedOrder));
        listing.seller = address(0);
        listing.price = 0;
        delete orders[id];
        if (!seaport.fulfillAdvancedOrder{value: msg.value}(order, new CriteriaResolver[](0), bytes32(0), msg.sender)
            || collection.ownerOf(id) != msg.sender || !_fullyFilled(orderHash)) revert InvalidFulfillment();
        emit OrderPurchased(id, msg.sender, orderHash, msg.value);
    }

    function _fullyFilled(bytes32 hash) private view returns (bool) {
        (, bool cancelled, uint256 filled, uint256 size) = seaport.getOrderStatus(hash);
        return !cancelled && size != 0 && filled == size;
    }

    function _checkOrder(AdvancedOrder calldata order) private view returns (uint256 id, uint256 price) {
        OrderParameters calldata p = order.parameters;
        if (p.offerer == address(0) || p.offerer == address(this) || p.offer.length != 1
            || p.consideration.length == 0 || p.consideration.length > MAX_CONSIDERATION_ITEMS
            || p.totalOriginalConsiderationItems != p.consideration.length
            || order.numerator != 1 || order.denominator != 1
            || order.signature.length > MAX_SIGNATURE_BYTES || order.extraData.length > MAX_EXTRA_DATA_BYTES
            || (p.orderType != OrderType.FULL_OPEN && p.orderType != OrderType.FULL_RESTRICTED)
            || (p.zone != address(0) && p.zone != allowedZone)
            || (p.orderType == OrderType.FULL_RESTRICTED && (allowedZone == address(0) || p.zone != allowedZone))
            || block.timestamp < p.startTime || block.timestamp >= p.endTime) revert UnsupportedOrder();
        OfferItem calldata item = p.offer[0];
        if (item.itemType != ItemType.ERC721 || item.token != address(collection)
            || item.startAmount != 1 || item.endAmount != 1) revert UnsupportedOrder();
        id = item.identifierOrCriteria;
        for (uint256 i; i < p.consideration.length; ++i) {
            ConsiderationItem calldata payment = p.consideration[i];
            if (payment.itemType != ItemType.NATIVE || payment.token != address(0) || payment.identifierOrCriteria != 0
                || payment.startAmount == 0 || payment.startAmount != payment.endAmount
                || payment.recipient == address(0) || payment.recipient == address(this)) revert UnsupportedOrder();
            price += payment.startAmount;
        }
    }
}
