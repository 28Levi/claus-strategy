# Claus Strategy

An immutable NFT treasury and reusable Programmable Custom Launch template for **ContractClaus on Ethereum**. The strategy charges **2% on buys and sells in its designated pool**, buys eligible NFTs with that ETH, offers them at **1.1× acquisition cost**, and uses sale proceeds to buy back and **burn ERC-20 supply**.

**Status: prelaunch.** This repository contains the implementation and verification evidence. The coin is not deployed, no production trading is enabled, and no independent audit is claimed. No mainnet transaction has been sent by this project. This is a reusable Custom Launch template, not a published Programmable catalog module.

The public project website is [Claus Strategy](https://claus-strategy.dreamy-gleam-6937.chatgpt.site); publishing the website and source does not launch the coin.

## Run locally

Use Node.js **24.14 or newer within Node 24** for the official launch CLI workflow. Install the pinned dependencies:

```sh
npm ci
npm run check
npm run demo
```

`check` compiles Solidity 0.8.26 and runs tests on an ephemeral Cancun EVM with the real Uniswap v4 PoolManager. `demo` runs the complete token-only launch, buy, fee collection, NFT purchase, resale and burn cycle. It writes `output/demo-report.json`; all balances and transactions are local. Normal tests do not contact Ethereum. The release-level official packer checks additionally require the separately installed, checksum-verified Programmable CLI described in [launch setup](docs/LAUNCH-GRAPH.md); otherwise those checks report that packing was not reproduced. The optional mainnet-fork test requires `CLAUS_FORK_RPC`; see [fork verification](docs/FORK-TEST.md).

## Website

The Claus-inspired website is implemented in `website/dist`, with collection artwork, an explanation of the strategy, a treasury view, an illustrative calculator and wallet actions guarded by deployment status. Preview it with:

```sh
node website/server.mjs
```

Open `http://127.0.0.1:4173`. The default prelaunch mode does not invent contract addresses, prices, holdings or trading activity. Its direct buy/sell implementation uses canonical Ethereum Uniswap v4 Universal Router, V4Quoter and Permit2 contracts, independently of Programmable's trading UI. Actual website quote and execution functions passed buy/sell tests against those deployed contracts on an isolated mainnet fork. Production trading still requires the real verified coin deployment and public website configuration. See [website operation](website/README.md) and [trading evidence](docs/WEBSITE-TRADING.md).

## Money and custody

```text
Buy/sell CLSTR in the designated pool
                 │ 2% native ETH fee claims → permissionless flushFees
                 ▼
           Acquisition reserve ◄── NFT holding rewards / donations
                 │ trusted bot selects an affordable OpenSea listing
                 ▼
       Treasury owns ContractClaus NFT
                 │ fixed offer: ceil(purchase price × 1.1)
                 ▼
       Buyer pays ETH and receives NFT
                 │ 100% of sale proceeds
                 ▼
             Buyback reserve
                 │ bounded swap, historical price minimum
                 ▼
        Strategy tokens burned; totalSupply decreases
```

- The treasury never grants NFT approval. Its sole outward NFT transfer is an exact-payment sale. The creator cannot withdraw, redeem, reprice, cancel, pause or upgrade it. There is no emergency rescue.
- The designated purchase bot selects an OpenSea order. The adapter verifies its signature, collection, ETH consideration, approvals and final custody through Seaport. The collection, market dependencies and bot address cannot change after launch.
- There is **no fixed NFT price cap or daily ETH spending cap** in the selected configuration. Prices may rise with the market; purchases require enough acquisition ETH. Price selection is trusted: a dishonest or compromised bot can overpay its own listing. This is the pricing risk the user explicitly accepted.
- Acquisition ETH and resale ETH have separate balances. Neither a caller nor the launch wallet chooses a buyback recipient or an arbitrary router call.
- Only the fixed bot can initiate an OpenSea acquisition; anyone can settle fees or trigger an eligible buyback. Transactions still require gas and a caller. The bot has no NFT withdrawal or approval rights, but its pricing authority is economically significant.
- Fees accrue as native ETH claims in the immutable hook during the swap. After the trader settles, anyone can call `flushFees`; its only destination is the treasury. This also works for the first buy when the pool starts with no ETH. The keeper performs this step before purchasing.
- Supply is minted once into the initializer. Launch liquidity is owned permanently by that initializer, which has no removal or withdrawal path. A failed launch rolls back atomically.

These are enforceable permissions and limits, **not a guarantee that the project is impossible to exploit or lose money on**. See [security boundaries](docs/SECURITY.md).

## Chosen draft configuration

The user selected ContractClaus, OpenSea acquisition, a 2% trading fee, no fixed purchase ceiling, and trusted bot pricing. [Economics and sources](docs/ECONOMICS.md) explain the remaining draft settings.

| Setting | Draft value |
| --- | --- |
| Chain / collection | Ethereum / `0x80396c7131159eB92E7E84839e51C9887A7A95d9` |
| Acquisition market | OpenSea listings fulfilled through the immutable Seaport 1.6 adapter |
| Supply / symbol | 1 billion, 18 decimals / `CLSTR` |
| Strategy trading fee | 2%; entirely to NFT acquisition reserve |
| LP fee | 0%; external routing or protocol fees are separate |
| Default launch | Token-only locked liquidity; 2 wei launch value, **plus transaction gas** |
| NFT ceiling / daily spend ceiling | None / none; only acquisition funds may be spent |
| Purchase spacing / inventory ceiling | 1 hour / 3 NFTs |
| NFT sale | Exactly 1.1× cost, rounded up to a wei |
| Buyback batch / spacing | Up to 0.01 ETH / 5 minutes |
| Buyback price check | 30-minute pool tick average; 1% output tolerance |

A gross purchase at 1.6 ETH creates a 1.76 ETH resale offer; a later 3 ETH purchase creates a 3.3 ETH offer. Those are examples, not live floor quotes. Purchase cost includes required OpenSea consideration fees. The launch value excludes gas and possible platform charges.

## User-facing integration boundaries

The fee applies to trades through this pool, not wallet transfers or other pools. The hook supports **exact-input swaps only**. A trading frontend must use that route and show the strategy fee plus any platform routing fee. The token has no creator allocation, transfer tax, blacklist or subsequent minting.

Acquisitions use **OpenSea/Seaport**. The bot fetches eligible native-ETH, fixed-price, single-NFT listings and fresh fulfillment authorization. Registration and purchase are atomic; unfillable orders cannot leave blocking quotes behind. The bot scans a bounded API window, so neither the client nor contract proves a complete global floor. See [OpenSea integration](docs/OPENSEA.md).

Treasury resale offers are recorded on the treasury and fulfilled with `buyNFT(id, recipient)`. They are **not automatically published on OpenSea**. Treasury NFTs are never approved to Seaport or a conduit.

The source template also includes `StrategyOfferMarket`, an optional escrow offer book for other ordinary ERC-721 collections that do not implement the Claus listing interface. Each collection and market still needs review; this template cannot remove powers held by someone else's NFT contract.

## Prepare a Programmable launch

```sh
npm run launch:prepare -- --config config/programmable.example.json --out output/launch-review.json
node scripts/build-launch-graph.mjs --config config/programmable.local.json --out output/launch
```

The reusable example leaves real wallets, metadata and source provenance unset; actual operator configuration is excluded from this repository. For this project, the controller and permanent bot are `0x14C51Aeb6b3B448d79C4e5F5Ff245c9878C4A800`, and the X profile is [@clausstrat](https://x.com/clausstrat). Before packing a real launch, use the exact public Git commit containing these sources and verify website/image access. The builder refuses incomplete inputs or a website marked as private. It produces an exact-source, five-contract deployment graph including the Seaport adapter, immutable bindings and hook-address mining; it does not sign or broadcast.

Follow [the current platform instructions](docs/PROGRAMMABLE.md). Programmable has retired new module catalog submissions; this is a **reusable Custom Launch source template**, not an installed item in its module picker. Server admission, wallet review, deployment and indexing remain separate steps. Current capability checks also distinguish source-launch availability from availability of Programmable's trading interface.

The exact production handoff is in [PRODUCTION-HANDOFF.md](docs/PRODUCTION-HANDOFF.md). Remaining launch work includes the production package bound to the exact published commit, authenticated OpenSea fulfillment and Programmable preflight, controller-funded deployment, verified production addresses and bot operation. No configured API access or successful authenticated production check is implied by the local tests.

## Operate after a verified deployment

```sh
# Read-only by default. Runtime hashes must come from verified deployment evidence.
node scripts/keeper.mjs --manifest deployment.json
# The immutable purchase bot signer and a per-transaction gas ceiling are required.
node scripts/keeper.mjs --manifest deployment.json --execute
```

Set `CLAUS_RPC_URL` and `OPENSEA_API_KEY`; execution additionally reads `CLAUS_KEEPER_PRIVATE_KEY`. Never put secrets in a manifest. A manifest supplies `chainId`, `contracts.{treasury,hook,token,collection,market,initializer,poolManager,seaport,conduitController,allowedZone}.{address,runtimeCodeHash}`, `acquisition.{venue,collectionSlug,purchaseBotAddress}` and `operator.maxGasCostWei`. The venue is `opensea`. The operator verifies bindings and the signer, then runs at most one fee settlement, one acquisition and one buyback per invocation. No live keeper has been started.

Gas comes from the caller, not a treasury reimbursement. Use current estimates and the keeper's monetary gas ceiling; this ceiling does not constrain the NFT purchase price. Losing the fixed bot key stops new OpenSea purchases: there is no admin rotation or recovery path.

## Verification scope

Tests cover actual v4 fee deltas, real swaps, mint-free fixed supply, locked initial liquidity, capped and explicitly uncapped acquisition policies, stale listings, correct resale rounding, reserve isolation, supply-reducing burns, immature/manipulated price rejection, unauthorized callbacks, reentrancy, dishonest executor rollback and launch-configuration validation. Retained optional fork evidence covers the deployed Claus collection, Seaport/conduit acquisition and custody, rejected invalid signed-zone authorization, legacy reward integration, and the website's canonical Uniswap buy/sell route. Hosted OpenSea fulfillment with a real API key remains a separate unexecuted check.

The completed verification run is recorded in [VERIFICATION.md](docs/VERIFICATION.md). Local tests and an implementation review do not replace independent review of the final compiled deployment or economic modeling. No independent audit, production admission, real launch, public catalog publication or live keeper operation is claimed.

