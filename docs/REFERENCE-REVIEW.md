# Reference and custody review

Reviewed 6 October 2026. This is integration research, not a complete audit or proof that a strategy cannot lose money. The original verified reference contracts are linked below; they are reference material, not application dependencies. Third-party reference source snapshots are not bundled in this public repository.

## Claus collection and native marketplace

The [Claus NFT documentation](https://claus.si/read/Hooks/NFTs) identifies Ethereum mainnet collection `0x80396c7131159eB92E7E84839e51C9887A7A95d9` and market `0x7832B1B34B8dBec979a44634BC095821c91FFc95`. Verified Solidity was retrieved directly from the Etherscan code pages on the review date.

- [ClausNFT source](https://etherscan.io/address/0x80396c7131159eB92E7E84839e51C9887A7A95d9#code): ordinary ERC-721 ownership and approval checks; no proxy, upgrade entry point, admin NFT seizure, collateral withdrawal, or arbitrary executor in the published source. The immutable `owner` can only open minting once. Token, art, reward pool manager, reward hook and VRF wrapper references are immutable. The source's `redeem(id)` requires the caller to be the actual current NFT owner, burns that NFT, and returns 50,000 CLAUS. An operator approval alone does not authorize redemption. Therefore a strategy must omit redemption and arbitrary call paths if its NFTs must only leave through a paid sale.
- [ClausNftMarket source](https://etherscan.io/address/0x7832B1B34B8dBec979a44634BC095821c91FFc95#code): fixed collection and fee recipient, no admin role or upgrade entry point. Seller retains custody until a purchase. The market charges exactly 200 basis points of the gross sale price.
- `ClausNFT` inherits time-weighted daily ETH rewards. Anyone may call `payRewards(epoch, accounts)`, but each payout always goes to its historical holder, with a 60,000-gas allowance. A strategy can receive rewards without delegating custody. Failed payouts remain owed and can be retried. Reward revenue depends on the external CLAUS pool/hook; immutability of NFT custody is not a guarantee of that revenue.

### Exact native market interface

```solidity
function collection() external view returns (address);
function FEE_BPS() external view returns (uint256); // 200
function listings(uint256 id) external view returns (
    address seller, uint256 price, uint256 transferNonce, uint256 revision
);
function isActive(uint256 id) external view returns (bool);
function list(uint256 id, uint256 price) external;
function cancel(uint256 id) external;
function buy(uint256 id, uint256 expectedRevision, address expectedSeller) external payable;
function deferredProceeds(address seller) external view returns (uint256);
function withdrawProceeds(address payable recipient) external;
```

`buy` requires the exact asking price, expected seller and revision, unchanged NFT transfer nonce, and the seller's current ownership. It calls `safeTransferFrom(seller, msg.sender, id)`, so the strategy or adapter making the purchase must implement the ERC-721 receiver callback. It then pays the fee recipient and seller using 60,000 gas each; failed payments become deferred credits. Only the credited seller can withdraw its own credit. A strategy wrapper must hardcode itself as the recipient of any such withdrawal.

For acquisition, validate the fixed collection, seller, revision, price and successful final custody; never accept arbitrary marketplace call data. For native marketplace resale, approval must be restricted to the fixed market. A gross 1.1x listing produces 1.078x purchase cost after its 2% fee, before gas. Selling through a strategy's own sale function avoids that market fee, but such listings are separate from native Claus marketplace listings.

## PunkStrategy

The [current official description](https://www.punkstrategy.fun/#how-it-works) says trading fees finance Punk purchases, followed by listing at 1.1x and token buybacks. It also discloses a team share of trading fees. This supplies an economic reference, not the requested custody guarantee.

The [original token/strategy source](https://etherscan.io/address/0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF#code) has owner-controlled ETH withdrawals, keeper rewards and relisting multipliers. A pinned RPC read shows its owner is the [PunkStrategyPatch contract](https://etherscan.io/address/0x1244eae9fa2c064453b5f605d708c0a0bfba4838#code). This later contract is the relevant current mechanism; do not mistake the original constructor defaults for current behavior.

The patch buys an arbitrary caller-selected public Punk listing when its price exceeds a fixed 6.9 ETH minimum and available funds suffice. It does not prove that the listing is the floor or enforce an upper fair-value bound. It lists immediately using a configurable multiplier. Sale proceeds are withdrawn from the Punks market, a caller reward is deducted, and the rest enters a queue of buyback chunks. The chunk function also deducts a reward. Its token swap passes zero minimum output and sends purchased tokens to the dead address. This locks tokens away but does not decrement the ERC-20 `totalSupply` field. Its so-called TWAP is time-separated execution, not an oracle that enforces a time-weighted fair price.

The patch still has owner-controlled ETH withdrawals, unbounded keeper reward changes, mutable buyback timing/size, fee-split changes and token ownership transfer. It therefore must not be copied as evidence of a no-withdrawal treasury. At block `0x18ec525`, the patch multiplier was 1100, matching 1.1x; its owner was nonzero. Raw reads are saved in `live-snapshot.json`. No live exploit was attempted.

## SNARKSTR

The [SNARKSTR website](https://snarkstr.com/) was retrieved directly over HTTPS. It describes a Solana coin whose ZEC trading fees finance Zcash NFT purchases, resale at 1.2x, and token buybacks/burns. It publishes ledger entries and a shielded viewing key. Its visible coin identifier is `ZVMihT6DKXWKRGX54VGvnYv4ndES8XtneUUYMCLpump`.

No treasury implementation, spending-key restrictions, deployment verification, upgrade-authority status or audit was linked from the reviewed page. A viewing key demonstrates visibility, not inability of a spending-key holder to withdraw. This reference does not establish the requested developer-proof custody constraint and should not drive the security design.

## Design implications

- Omit owner/admin withdrawal, NFT redemption, arbitrary calls, delegate calls, approvals to arbitrary spenders, mutable destinations and upgrade paths. Enforce this for every factory-created instance.
- Treat the collection and marketplace as security dependencies. A generic ERC-721 interface cannot detect an external collection's admin seizure or upgrade privileges. Collection eligibility requires a review of each deployment; the factory cannot honestly promise every user-supplied collection is safe.
- Market listing validity is not price validity. The user subsequently chose uncapped OpenSea acquisitions and explicitly accepted trusted bot pricing. The adapter restricts submission to an immutable bot, which can still overpay. This accepted trust replaces the fixed-cap proposal and is separate from no-withdrawal custody. Even a correctly observed floor can be manipulated in a thin collection.
- Buybacks need an enforced nonzero economic minimum, bounded chunks and a manipulation-resistant price reference. A caller-supplied minimum alone can be set to one; a spot quote can be manipulated. Never call an unprotected chunked market buy a fair-price TWAP.
- The strategy can enforce custody and payment rules. It cannot guarantee that an NFT sells at 1.1x, that its value remains above cost, or that the purchased coin's market price rises. Fixed resale prices can leave inventory unsold indefinitely.

## Remaining verification

This research did not independently recompile deployed reference bytecode, execute mainnet transactions, audit all transitive external dependencies or verify SNARKSTR's private execution system. Local strategy tests do not replace a pinned mainnet fork integration against the actual collection, marketplace, pool and platform launch module.
