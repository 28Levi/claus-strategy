// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IRevisionedNFTMarket} from "./interfaces/IRevisionedNFTMarket.sol";

interface IStrategyExecutor {
    function token() external view returns (address);
    function treasury() external view returns (address);
    function executeBuyback() external payable returns (uint256);
}

interface IBurnableStrategyToken is IERC20 {
    function burn(uint256 amount) external;
}

/// @notice Custody without an owner. Only a paid, fixed-price sale can release a purchased NFT.
/// @dev Optional spend caps are loss bounds, not fair-value proofs. Zero disables a cap.
contract StrategyTreasury is IERC721Receiver, ReentrancyGuard {
    struct Config {
        address token;
        address collection;
        address market;
        address initializer;
        uint256 firstTokenId;
        uint256 tokenCount;
        uint256 maxPurchasePrice;
        uint256 maxSpendPerEpoch;
        uint32 epochDuration;
        uint32 minPurchaseInterval;
        uint32 maxInventory;
        uint256 maxBuybackAmount;
        uint32 minBuybackInterval;
    }

    struct Position { uint256 cost; uint256 ask; }
    struct Quote { uint256 tokenId; address seller; uint256 price; uint256 revision; bool found; }

    IBurnableStrategyToken public immutable token;
    IERC721 public immutable collection;
    IRevisionedNFTMarket public immutable market;
    address public immutable initializer;
    uint256 public immutable firstTokenId;
    uint256 public immutable tokenCount;
    uint256 public immutable maxPurchasePrice;
    uint256 public immutable maxSpendPerEpoch;
    uint32 public immutable epochDuration;
    uint32 public immutable minPurchaseInterval;
    uint32 public immutable maxInventory;
    uint256 public immutable maxBuybackAmount;
    uint32 public immutable minBuybackInterval;
    uint256 public constant RESALE_BPS = 11_000;

    // Set once by the atomic launch initializer. There is no replacement or reset.
    IStrategyExecutor public hook;
    mapping(uint256 => Position) public positions;
    uint256 public acquisitionBalance;
    uint256 public buybackBalance;
    uint256 public inventoryCount;
    uint256 public totalFeesReceived;
    uint256 public totalAcquisitionSpent;
    uint256 public totalSaleProceeds;
    uint256 public totalBuybackSpent;
    uint256 public totalTokensBurned;
    uint256 public spentInEpoch;
    uint256 public spendEpoch;
    uint256 public nextPurchaseAt;
    uint256 public nextBuybackAt;
    bool private acquiring;
    uint256 private pendingTokenId;

    error InvalidConfig();
    error Unauthorized();
    error AlreadyInitialized();
    error Inactive();
    error NoEligibleListing();
    error StaleQuote();
    error PurchaseLimit();
    error Cooldown();
    error InvalidNFT();
    error InvalidPayment();
    error InvalidBuyback();

    event Initialized(address indexed hook);
    event FeesReceived(uint256 amount);
    event AcquisitionFunded(address indexed sender, uint256 amount);
    event NFTPurchased(uint256 indexed tokenId, address indexed seller, uint256 cost, uint256 ask);
    event NFTSold(uint256 indexed tokenId, address indexed buyer, address indexed recipient, uint256 proceeds);
    event BuybackBurned(uint256 ethSpent, uint256 tokensBurned);

    constructor(Config memory c) {
        if (c.token.code.length == 0 || c.collection.code.length == 0 || c.market.code.length == 0
            || c.initializer == address(0) || c.tokenCount == 0 || c.tokenCount > 512
            || c.firstTokenId > type(uint256).max - c.tokenCount
            || (c.maxSpendPerEpoch != 0 && c.maxPurchasePrice > c.maxSpendPerEpoch)
            || c.epochDuration < 1 hours || c.minPurchaseInterval < 1 minutes
            || c.maxInventory == 0 || c.maxInventory > c.tokenCount
            || c.maxBuybackAmount == 0 || c.minBuybackInterval < 1 minutes
            || IRevisionedNFTMarket(c.market).collection() != c.collection) revert InvalidConfig();
        token = IBurnableStrategyToken(c.token);
        collection = IERC721(c.collection);
        market = IRevisionedNFTMarket(c.market);
        initializer = c.initializer;
        firstTokenId = c.firstTokenId;
        tokenCount = c.tokenCount;
        maxPurchasePrice = c.maxPurchasePrice;
        maxSpendPerEpoch = c.maxSpendPerEpoch;
        epochDuration = c.epochDuration;
        minPurchaseInterval = c.minPurchaseInterval;
        maxInventory = c.maxInventory;
        maxBuybackAmount = c.maxBuybackAmount;
        minBuybackInterval = c.minBuybackInterval;
    }

    function initializeHook(address hook_) external {
        if (msg.sender != initializer) revert Unauthorized();
        if (address(hook) != address(0)) revert AlreadyInitialized();
        if (hook_.code.length == 0 || IStrategyExecutor(hook_).token() != address(token)
            || IStrategyExecutor(hook_).treasury() != address(this)) revert InvalidConfig();
        hook = IStrategyExecutor(hook_);
        emit Initialized(hook_);
    }

    function recordFees() external payable {
        if (msg.sender != address(hook) || msg.sender == address(0)) revert Unauthorized();
        acquisitionBalance += msg.value;
        totalFeesReceived += msg.value;
        emit FeesReceived(msg.value);
    }

    /// @notice Direct donations and Claus NFT holding rewards fund subsequent purchases.
    receive() external payable {
        acquisitionBalance += msg.value;
        emit AcquisitionFunded(msg.sender, msg.value);
    }

    /// @notice Forced ETH can only be assigned to acquisitions, never sent to a caller.
    function accountSurplus() external {
        uint256 surplus = address(this).balance - acquisitionBalance - buybackBalance;
        acquisitionBalance += surplus;
        emit AcquisitionFunded(address(0), surplus);
    }

    /// @notice Minimum among active quotes exposed by the fixed acquisition market.
    /// @dev The OpenSea adapter exposes the trusted bot's atomic candidate only.
    ///      This does not prove an OpenSea/global floor or fair market value.
    function cheapestListing() public view returns (Quote memory q) {
        uint256 end = firstTokenId + tokenCount;
        for (uint256 id = firstTokenId; id < end; ++id) {
            if (positions[id].ask != 0 || !market.isActive(id)) continue;
            (address seller, uint256 price,, uint256 revision) = market.listings(id);
            if (seller == address(this) || price == 0 || (maxPurchasePrice != 0 && price > maxPurchasePrice)) continue;
            if (!q.found || price < q.price) q = Quote(id, seller, price, revision, true);
        }
    }

    /// @notice Buy an eligible market quote; OpenSea quote selection is restricted by its adapter.
    function purchaseCheapest(uint256 expectedTokenId, uint256 expectedRevision) external nonReentrant {
        if (address(hook) == address(0)) revert Inactive();
        if (block.timestamp < nextPurchaseAt) revert Cooldown();
        Quote memory q = cheapestListing();
        if (!q.found) revert NoEligibleListing();
        if (q.tokenId != expectedTokenId || q.revision != expectedRevision) revert StaleQuote();
        uint256 epoch = block.timestamp / epochDuration;
        uint256 spent = epoch == spendEpoch ? spentInEpoch : 0;
        if (q.price > acquisitionBalance || (maxSpendPerEpoch != 0 && spent + q.price > maxSpendPerEpoch)
            || inventoryCount >= maxInventory) revert PurchaseLimit();

        acquisitionBalance -= q.price;
        totalAcquisitionSpent += q.price;
        spentInEpoch = spent + q.price;
        spendEpoch = epoch;
        nextPurchaseAt = block.timestamp + minPurchaseInterval;
        inventoryCount++;
        uint256 ask = Math.mulDiv(q.price, RESALE_BPS, 10_000, Math.Rounding.Ceil);
        positions[q.tokenId] = Position(q.price, ask);
        acquiring = true;
        pendingTokenId = q.tokenId;
        market.buy{value: q.price}(q.tokenId, q.revision, q.seller);
        acquiring = false;
        if (collection.ownerOf(q.tokenId) != address(this)) revert InvalidNFT();
        emit NFTPurchased(q.tokenId, q.seller, q.price, ask);
    }

    /// @notice Always available at exactly 1.1x acquisition cost, rounded up to a wei.
    /// @dev No marketplace approval is granted. Only this paid endpoint transfers an NFT out.
    function buyNFT(uint256 id, address recipient) external payable nonReentrant {
        uint256 ask = positions[id].ask;
        if (ask == 0 || msg.value != ask || recipient == address(0) || recipient == address(this)) revert InvalidPayment();
        delete positions[id];
        inventoryCount--;
        buybackBalance += msg.value;
        totalSaleProceeds += msg.value;
        collection.safeTransferFrom(address(this), recipient, id);
        emit NFTSold(id, msg.sender, recipient, msg.value);
    }

    /// @notice Public, bounded batches. Executor determines the immutable TWAP slippage bound.
    function executeBuyback() external nonReentrant returns (uint256 burned) {
        if (address(hook) == address(0)) revert Inactive();
        if (block.timestamp < nextBuybackAt) revert Cooldown();
        uint256 amount = Math.min(buybackBalance, maxBuybackAmount);
        if (amount == 0) revert InvalidBuyback();
        nextBuybackAt = block.timestamp + minBuybackInterval;
        buybackBalance -= amount;
        uint256 beforeBalance = token.balanceOf(address(this));
        uint256 reported = hook.executeBuyback{value: amount}();
        burned = token.balanceOf(address(this)) - beforeBalance;
        if (burned == 0 || burned != reported) revert InvalidBuyback();
        uint256 supplyBefore = token.totalSupply();
        token.burn(burned);
        if (token.totalSupply() != supplyBefore - burned || token.balanceOf(address(this)) != beforeBalance) revert InvalidBuyback();
        totalBuybackSpent += amount;
        totalTokensBurned += burned;
        emit BuybackBurned(amount, burned);
    }

    function onERC721Received(address, address, uint256 id, bytes calldata) external view returns (bytes4) {
        if (msg.sender != address(collection) || !acquiring || id != pendingTokenId) revert InvalidNFT();
        return IERC721Receiver.onERC721Received.selector;
    }
}
