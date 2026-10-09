# Custody properties and remaining trust

This document describes the intended, tested deployment. It does not certify arbitrary deployments that copy the name, ABI or interface getters.

## Protected operations

`StrategyTreasury` has no owner, asset withdrawal, NFT approval, redemption, arbitrary external-call, delegate-call, pause, price setter or upgrade entry point. For a purchased NFT, `buyNFT` is the sole transfer-out path. It requires exact payment of the immutable 1.1× offer and credits every wei to the buyback reserve before transfer. Reentrant purchase, sale and buyback calls fail; rejected delivery rolls back the sale.

The treasury separates acquisition revenue and resale proceeds. A purchase cannot spend the resale reserve; a buyback cannot spend the acquisition reserve. Forced ETH and direct NFT rewards can only increase the acquisition reserve. The fee receipt function is restricted to the bound hook. Buyers and keepers cannot set fee destinations.

OpenSea purchases use a fixed `SeaportListingMarket` adapter with an immutable purchase bot. Every order is registered and fulfilled atomically: signed, fixed-price, full native-ETH consideration for exactly one NFT from the configured collection, delivered directly to the treasury. Invalid signatures, cancelled orders, revoked approvals, failing payment recipients and rejected zone authorization roll back registration and spending. The adapter rejects arbitrary targets, bundles, criteria orders, partial fills, dynamic prices and unsigned tips. Only the pinned Seaport, controller and supported zone participate; seller conduit channels and approvals are checked. The treasury never approves its NFTs to Seaport or a conduit.

**Accepted pricing trust:** the selected strategy has no fixed NFT purchase or daily spending ceiling. Only its immutable bot can submit acquisition orders. The bot uses OpenSea API listings, whose completeness and fair price cannot be established by the contract. A malicious or compromised bot can spend acquisition funds on an overpriced NFT, including its operator's own NFT. No-withdrawal custody does not remove this economic extraction path. The user explicitly chose this trust model over independent price attestations. There is no bot rotation; key loss stops new acquisitions, while paid resales, fee settlement and eligible buybacks remain available.

During a swap, fees accrue as native ERC-6909 claims in the hook. This balances the hook's fee delta without depending on already-settled ETH, which matters on the first trade of a token-only launch. After settlement, permissionless `flushFees` burns those claims and transfers ETH exclusively to the treasury. Its operation guard prevents nesting another flush or buyback. A reverting trade also reverts claim accrual; a reverting flush preserves all claims and pending accounting.

`StrategyV4Hook` accepts its declared callbacks only from the fixed PoolManager and only for its own pool key. Only the treasury may initiate an internal buyback. Swaps have an immutable minimum output derived from a rolling cumulative tick oracle, with at least 30 minutes of history; no caller supplies a weaker minimum. The treasury verifies token balance deltas and an actual total-supply decrease. A failed swap or burn reverses the entire transaction.

Both initializers own their liquidity positions permanently and expose no removal, collection or arbitrary-call method. Their launch authority has one atomic setup action. Every token initially belongs to the initializer; no developer premint is distributed. The token-only initializer fixes its launch price/range and requires exactly 2 wei. The balanced variant requires at least 99% of both supplied assets to enter liquidity.

The treasury's hook binding is a one-time initialization operation, not a changeable administrator role. The canonical graph must perform it inside the atomic launch. Deploying a treasury with an EOA initializer or a counterfeit hook is outside this safety claim.

## Things these controls do not prove

1. **NFT value.** The OpenSea adapter exposes the bot's candidate only during its atomic purchase. The treasury's `cheapestListing` compatibility method does not prove a global OpenSea floor. Sellers, including the creator, may sell their own NFTs. Optional caps remain available in other template configurations, but the selected uncapped configuration trusts bot pricing. The creator can buy treasury NFTs only by paying the full asking price.
2. **Manipulation-proof buybacks.** The oracle uses this pool's own price. Thin liquidity or a sustained adversarial price can influence a 30-minute average. Batching and output limits reduce exposure but cannot establish an independent fair price. Market movement can also stop buybacks until conditions permit them.
3. **Guaranteed resale.** The 1.1× offer may remain unsold indefinitely. Inventory and ETH can become stranded because nobody, including the developer, can relax the policy or rescue them.
4. **External collection safety.** An ERC-721 may contain seizure, upgrade, burn or transfer-blocking powers. ABI checks cannot detect those powers. The reviewed Claus source has no observed NFT seizure/upgrade path, but every other collection/market needs its own review and exact code verification. Underlying CLAUS collateral and reward income carry their own dependencies.
5. **Universal taxation.** The 2% applies to the designated pool. Direct token transfers and independently created pools are untaxed. Platform routing and PoolManager protocol fees are outside this hook's control.
6. **Automatic execution.** A keeper or user must send transactions and pay gas. Failed transactions can still cost the sender gas. There is no guaranteed keeper or treasury reimbursement. No keeper has been activated on mainnet.
7. **Recovery of unsupported assets.** Unsolicited safe NFT transfers are rejected. An unsafe transfer, unrelated ERC-20 transfer or other unsupported asset can become permanently inaccessible. There is no rescue function that could later become a withdrawal backdoor.
8. **Authenticity of clones.** A malicious contract can return expected getters. Verify exact runtime bytes, constructor arguments, initializer, pool manager, collection and market against the admitted source graph. The keeper's runtime manifest is only as trustworthy as the deployment verification that produced it.

## Implementation verification

Tests execute the real pinned Uniswap v4 PoolManager and Seaport on a Cancun EVM. Local OpenSea tests use a mock NFT, synthetic signed orders and a restricted-zone fixture; API tests use wire-format fixtures. A separate passing Ethereum fork exercises the deployed Seaport, real Claus collection and canonical conduit controller with a synthetic order, and rejects invalid OpenSea signed-zone authorization. Another passing fork exercises the website's actual buy/sell functions against deployed Uniswap routing contracts. Legacy native-market tests also cover collection reward checkpoints. None of these substitutes for a successful hosted OpenSea API fulfillment or verification of the final production deployment. See [verification evidence](VERIFICATION.md).

There has been no independent audit of the final deployment, no proof of absence of all vulnerabilities and no guarantee of profitable operation. Before a real launch, review final source/runtime evidence, platform admission and actual trade routing; publish exact verified addresses so a counterfeit deployment cannot inherit these claims.
