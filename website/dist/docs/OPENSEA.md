# OpenSea acquisition

The Claus launch template acquires the Ethereum [ContractClaus collection](https://opensea.io/collection/contractclaus), `0x80396c7131159eB92E7E84839e51C9887A7A95d9`, through OpenSea Seaport listings. `strategy.acquisitionVenue` is `opensea` and `strategy.collectionSlug` is `contractclaus` in the example configuration. No live purchase, wallet transaction or deployment has been made.

## Payment policy

The user requested removing fixed purchase and daily ETH ceilings so the strategy can follow a rising floor. Both example limit fields now use `"0"` as the explicit no-ceiling setting. The user selected the **trusted purchase bot** model and accepted its pricing risk; **1.6 ETH is an illustration, not a fixed ceiling**. Every required native-ETH consideration item counts toward the gross acquisition cost, including seller payment, marketplace fee and required creator fees. The treasury must have sufficient acquisition funds for the complete signed payment. NFT sale proceeds remain reserved for token buybacks and cannot fund new NFT acquisitions.

The treasury needs enough accumulated trading fees to pay the gross amount. The keeper separately pays gas for order registration and purchase calls. At a recorded 1.6 ETH acquisition cost, the treasury's automatic 1.1-times sale price is **1.76 ETH**. This change adds OpenSea acquisition; resale still uses the treasury's fixed-price sale endpoint, and does not create an OpenSea resale listing.

## Execution and custody

The launch graph adds `SeaportListingMarket` as a fifth target and binds the treasury's marketplace immutable to that target. Its `purchaseBot` address is immutable and comes from the explicit `strategy.purchaseBotAddress` launch setting. The builder refuses to proceed while this address is missing; it does not default to the creator. External dependencies are fixed in `config/opensea.ethereum-release.json`:

| Dependency | Ethereum address |
| --- | --- |
| Seaport 1.6 | `0x0000000000000068F116a894984e2DB1123eB395` |
| ConduitController | `0x00000000F9490004C11Cef243f5400493c00Ad63` |
| OpenSea signed zone | `0x000056f7000000ece9003ca63978907a00ffd100` |

The first two addresses are listed by the [official Seaport repository](https://github.com/ProjectOpenSea/seaport#deployments). OpenSea documents the [Seaport 1.6 signed zone](https://docs.opensea.io/changelog/seaport-v1-6). Address pinning alone is not an independent deployed-bytecode or privilege audit.

The adapter accepts a constrained listing for exactly one NFT of the bound collection, with a fixed price paid in native ETH. Seaport validates the seller's signed order. Only `FULL_OPEN` and `FULL_RESTRICTED` order types are supported; partial-fill types, ERC-20 prices, bundles, criteria items, changing prices and unsigned tips are rejected. Restricted orders use the pinned OpenSea zone and require current fulfillment authorization. The adapter reconstructs the constrained Seaport fulfillment instead of executing arbitrary API-provided target/calldata. The NFT arrives in the treasury, which records its exact cost and exposes only its fixed-price sale path. The treasury does not approve Seaport or a conduit to withdraw its inventory, and the adapter adds no developer withdrawal authority.

## Listings and automation

OpenSea orders are off-chain listings. The designated purchase bot retrieves candidate listings and obtains fulfillment information. Only that immutable bot can call `registerAndPurchase`, which registers and purchases in one transaction; failed fulfillment reverts the registration too. There is no persistent quote cache. This prevents stale zone data or a seller payment recipient that rejects ETH from leaving an unfillable quote in the adapter. Other callers cannot initiate OpenSea acquisitions. The bot cannot bypass the supported order shape, exact payment, treasury custody or buyback-reserve accounting.

The on-chain order validation proves a seller authorized the offered NFT for its stated price. It does **not** prove this candidate is the OpenSea floor or fairly priced. The bot selects the cheapest supported API listing, and the contract cannot prove off-chain order-book completeness. A dishonest or compromised bot could direct acquisition funds to an inflated eligible listing from a collaborating seller while omitting cheaper listings. This pricing risk is explicitly accepted by the user and can affect the entire available acquisition balance. There is no cryptographically verified OpenSea floor in this adapter.

The bot cannot directly withdraw ETH or remove treasury NFTs. There is no owner setter, bot rotation or recovery path. A lost bot key therefore stops new acquisitions, while custody, resale and buyback rules remain callable under their existing rules. This liveness tradeoff must be understood before binding the real bot address.

OpenSea's [fulfillment API](https://docs.opensea.io/reference/generate_listing_fulfillment_data_v2) supplies the signatures and restricted-zone data required to execute listings. A valid OpenSea API key and a live, supported listing are needed to verify this hosted API flow. Authorization must identify the adapter as the Seaport caller and the treasury as the NFT recipient. Expired or revoked listings and stale zone data can stop purchases; the keeper must refresh them. API failure must never enable a native-market fallback or bypass the treasury's acquisition-reserve accounting.

`scripts/opensea.mjs` reads the API key from the local `OPENSEA_API_KEY` environment variable by default. It never embeds credentials in launch artifacts. The keeper uses its typed order output rather than broadcasting API-provided calldata. Missing API access or a signer that differs from the immutable bot must stop acquisition automation.

## Verification boundaries

Local tests should establish actual Seaport signature/order execution, exact gross-cost accounting, treasury custody, fixed-price resale, buyback/burn, malformed-order rejection and binding of all adapter constructor/runtime values into the official launch graph. These tests do not by themselves verify live OpenSea API access, current ContractClaus order availability, production fulfillment authorization, gas cost or platform admission. Those checks remain separate before any launch or funded purchase. An OpenSea API key was not available during this change, so authenticated live fulfillment remains unverified.
