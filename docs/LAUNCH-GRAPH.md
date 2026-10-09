# Programmable launch and reusable source template

Checked against official public discovery on **9 October 2026**. This repository generates unsigned exact-source launch inputs. It has not been submitted, admitted, deployed or published in Programmable's module catalog.

## Current platform and fees

The Ethereum API is `/v3`, but the fresh submission profile is **3.6.0** and the official CLI release is **@programmable/launch 4.1.4**. The old `/schemas/custom-launch/v3/pack-config.json` still describes older profiles. The current schema is pinned from the exact source commit bound by the published [4.1.4 release](https://github.com/programmablehq/PROGRAMMABLE/releases/tag/programmable-launch-v4.1.4), `3f5d43fb3787a0b880edc685d5b554dae5074174`. Provenance and digests are in `config/schemas/sources.json`.

`config/programmable.ethereum-release.json` records the official tarball checksum, graph factory, PoolManager, runtime hashes and routed fee-policy hash. Their external deployed runtime hashes were read back at Ethereum block 26,154,629 and matched the release pins; see [platform-runtime-proof.json](verification/platform-runtime-proof.json). The local builder does not repeat that RPC check or verify new strategy deployments. The CLI requires Node `>=24.14.0 <25`.

The user selected **2% on buys and sells for the NFT treasury**. The hook's pool has a **0% LP fee**, matching the reference strategy. [Current capabilities](https://api.programmable.market/v3/capabilities) and the [fees guide](https://programmable.market/docs/economics) declare a separate 0.30% charge on Programmable-routed trades. The 2% is the strategy share, not an all-in fee promise. Trade price impact and gas are additional. Fees on other pools and external routes are not guaranteed by this hook.

During swaps, the strategy fee accrues as native ETH claims in PoolManager. Anyone can call `flushFees()` to redeem those claims exclusively into the fixed treasury; the caller cannot select a recipient. The keeper flushes pending fees before attempting an NFT purchase. This also supports the first buy into a token-only pool with no pre-existing ETH balance.

Profile 3.6 supports 3–16 targets and does not require a canonical platform fee vault. The official packer binds its routed fee policy. Naming this hook as the profile's fee binding target does not assert that it collects Programmable's fee itself.

At the check time, production launch authorization was active but **onsite trading was disabled** with `PROVIDER_IDENTITY_CONFIG_MISSING`. Deployment admission does not establish onsite trading availability. The strategy website implements a separate direct Uniswap buy/sell route, verified against canonical contracts in an isolated Ethereum fork; it does not require Programmable's trading UI. Its production mode still requires the actual verified strategy deployment. See [WEBSITE-TRADING.md](WEBSITE-TRADING.md). Recheck live capabilities immediately before preflight/submission.

**New catalog module contributions remain retired**, according to the [module API page](https://programmable.market/developers/module-mode-api-v1.md). This implementation is a reusable Custom Launch source template, not a newly published catalog module.

## Draft defaults

The confirmed Ethereum NFT is [ContractClaus](https://opensea.io/collection/contractclaus), `0x80396c7131159eB92E7E84839e51C9887A7A95d9`, with fixed IDs 1–300. Acquisitions now use OpenSea listings through a dedicated `SeaportListingMarket` adapter. The adapter pins Ethereum Seaport 1.6, its ConduitController and OpenSea's signed zone from `config/opensea.ethereum-release.json`; the graph deploys it before the treasury. The native Claus marketplace is no longer the default. See [OpenSea acquisition](OPENSEA.md) for supported orders and keeper requirements.

The reference-style launch uses one billion tokens with 18 decimals and a token-only locked liquidity position with 2 wei transaction value. This is not a funded ETH exit reserve: buyers must first add ETH through purchases. Gas remains a separate actual cost. The balanced mode also remains available for a real two-sided seed.

The user requested **no fixed NFT purchase or daily ETH ceiling**. Both configuration fields now use `"0"` to mean no fixed ceiling, rather than freezing the strategy at the reported 1.6 ETH floor. The treasury still needs sufficient acquisition funds and preserves the separate buyback reserve, one-hour acquisition cooldown and maximum inventory three. Every signed native-ETH consideration item, including required marketplace and creator fees, counts toward cost. Gas paid by the keeper is separate. A purchase costing 1.6 ETH would be offered at 1.76 ETH; those numbers are illustrative.

The user selected **trusted-bot pricing** (`strategy.pricingPolicy.mode: "trusted-bot"`) and accepted its pricing risk. Only the immutable `strategy.purchaseBotAddress` can execute OpenSea acquisitions through the adapter. Supply the real bot wallet separately; neither the creator wallet nor a fabricated address is substituted automatically. There is no bot replacement or key-rotation path. Losing that key stops new OpenSea acquisitions; compromising it permits valid NFT purchases at inflated prices up to available acquisition funds. OpenSea listings are off-chain, so the contract cannot prove a submitted candidate is the global floor. The bot has no direct ETH withdrawal or treasury NFT transfer authority. Buybacks still use batches up to 0.01 ETH with a five-minute cooldown, 30-minute TWAP and 1% output tolerance.

`maxLaunchValueWei` covers the 2 wei seed, while `maxGasCostWei` is a 0.02 ETH review ceiling. Neither is evidence of funding or an actual gas estimate. If official transaction value, live gas estimates or available funds disagree, stop and revise the reviewed package. Do not silently increase a budget.

## Build the actual source graph

Copy `config/programmable.example.json` to a local configuration, supply the actual controller wallet, trusted purchase bot wallet, metadata/image, public source URL/revision, launch nonce and permit window. Image paths are relative to the configuration. Public source provenance must be checked separately; the builder does not assert that the supplied revision exists or matches the local source.

```sh
node scripts/build-launch-graph.mjs --config config/programmable.local.json --out artifacts/launch --require-ready
```

Incomplete inputs produce a blocker report. Complete inputs produce the actual Solidity sources/dependencies, exact solc 0.8.26 Standard JSON, five compiled artifacts and `programmable-launch.config.json`, validated against the pinned official schema.

| Target | Constructor dependencies | Atomic launch |
| --- | --- | --- |
| initializer | Official graph factory authority | One-time treasury binding, pool initialization and locked liquidity settlement |
| token | initializer | Entire fixed supply minted to initializer |
| market | collection, pinned Seaport 1.6, ConduitController, signed zone and purchase bot | Immutable acquisition adapter and bot; no treasury NFT approvals |
| treasury | token, initializer, collection, market target and limits | Hook set exactly once by initializer |
| hook | token, treasury, initializer, PoolManager, 2% fee and oracle policy | Only initializer may initialize the bound pool |

The constructor graph has no cycle. Initializer calldata references treasury and hook. The packer derives CREATE2 addresses and ABI byte offsets and grinds the hook salt to permission mask `0x30cc`. All runtime immutables are mapped from actual compiler AST IDs; unknown immutables fail closed. No deployment address or signature is fabricated.

The token-only pool starts exactly at its upper tick. Its initial active liquidity and ETH reserves are zero until the first buy crosses that boundary; the locked token position exists already. Real PoolManager buy/sell tests pass for that transition. The public profile names a `liquidity.seeded.pool-active-liquidity` assessment vector without specifying its measurement time or threshold. Local success and packing do not establish that the platform's private assessment will accept this launch boundary. Resolve any actual admission finding before signing; do not silently change the initial price.

Exact source and image bytes determine graph identity. Preserve the same nonce and exact bytes for retries; changing either requires a newly reviewed package. The builder emits no wallet transaction and does not read credentials, call authenticated endpoints or broadcast.

## Official packing and review

Verify the official release tarball against its pinned checksum and install using the supported Node version. Use the official CLI:

```sh
programmable-launch pack --config artifacts/launch/programmable-launch.config.json
```

Read that release's `--help` for exact local-validation and authenticated-preflight flags. Successful local schema validation is not platform admission. Builder report fields `officialCliPacked`, `remotelyAdmitted` and `deployed` remain false.

Set `officialInputPath` in the local review configuration to the generated pack configuration, then optionally run the separate read-only checks:

```sh
node scripts/prepare-launch.mjs --config config/programmable.local.json --live --rpc-env CLAUS_RPC_URL --out artifacts/launch-review.json --require-ready
```

This only reads public capabilities and optional network/collection-code RPC results. It does not establish marketplace compatibility, source provenance, runtime immutability, fair value or oracle safety. Wallet readiness is always false in this preliminary helper.

The report records Programmable onsite trading status and its blockers separately from source packing and from the independent direct website route. It also reports only whether required environment credentials are present, without exposing or validating them. The actual operator manifest template and next commands are in [PRODUCTION-HANDOFF.md](PRODUCTION-HANDOFF.md).

The official sequence is pack → authenticated preflight → submit for review → approval/start → controller review/sign → finality → runtime/source/indexing and actual trading checks. The [current launch guide](https://programmable.market/developers/custom-launch-api-v1.md) defines the separate review and launch windows. Review exact transaction value, gas and available balance before signing.

## Evidence and remaining gates

`test/launch-graph.test.mjs` compiles both sets of actual contracts, verifies the official schema, checks constructor and initializer references, maps every runtime immutable and verifies fee/funding values. It checks the bot binding and both zero/no-ceiling values explicitly. When the verified CLI is installed at `artifacts/programmable-cli/node_modules/@programmable/launch`, it also constructs unsigned requests through the official packer and writes `artifacts/launch-graph-token-only-test-proof.json` and `artifacts/launch-graph-balanced-test-proof.json`. These proofs use explicitly synthetic test metadata and a synthetic bot address; they are not production launch packages. The 9 October run used the supported Node 24.14.0 runtime.

A real launch still needs actual missing inputs, public source provenance, external runtime/privilege checks, real-mainnet market/PoolManager fork verification, independent contract review, platform admission and deployed trade verification. Local tests or a platform stamp cannot prove profitability or impossibility of exploitation.

Other creators can reuse the source with a reviewed ERC-721 collection of at most 512 IDs, its matching OpenSea slug and a completed pricing policy. The OpenSea graph always deploys the reviewed adapter; an external marketplace address cannot replace it silently. A separate explicit `acquisitionVenue: "native"` mode retains the legacy revisioned-market graph for tests or reviewed integrations. There is no creator withdrawal or contract upgrade path. A different template version creates a different deployment and cannot modify an existing strategy.
