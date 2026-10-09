# Production launch and operation

This is the handoff for the actual Ethereum Claus Strategy. The contracts are not deployed. Local verification and deterministic packing do not create a coin or establish live trading. The source template is described in [LAUNCH-GRAPH.md](LAUNCH-GRAPH.md). Regenerate the readiness report from the actual local launch inputs; this public snapshot excludes operator configuration and earlier readiness reports.

Public website access was enabled on 9 October 2026 at [Claus Strategy](https://claus-strategy.dreamy-gleam-6937.chatgpt.site). The site remains in prelaunch mode. This public source snapshot contains no mainnet deployment, authenticated admission or running-bot claim. Bind the eventual launch package to the actual published Git commit containing these source bytes; an archive checksum is not a Git revision.

## Bound choices

The user confirmed `0x14C51Aeb6b3B448d79C4e5F5Ff245c9878C4A800` for both the launch controller and permanent purchase bot. Operator-specific configuration is excluded from this public repository. The example configuration deliberately retains null wallet fields so other creators do not launch with someone else's wallet.

The project X profile is [@clausstrat](https://x.com/clausstrat), and the selected image is `website/dist/assets/claus-001.png`. Set both in the operator's local configuration. Its image path is `../website/dist/assets/claus-001.png` because image paths resolve relative to the configuration file. The expected website address is `https://claus-strategy.dreamy-gleam-6937.chatgpt.site`; set `publication.websiteAccess` to `public` only after confirming credential-free access to the page and selected image.

- Ethereum Mainnet, ContractClaus collection, OpenSea/Seaport acquisition.
- Token name `Claus Strategy`, symbol `CLSTR`, one billion tokens, 18 decimals.
- 2% strategy fee on native ETH buys and sells through the bound pool; 0% LP fee. The website's direct Uniswap route includes this 2% fee in its quote. Programmable separately declares a 0.30% fee when its own routed trading service is used; the direct website encoder does not add that separate platform charge. Gas and price impact are additional on both routes.
- Both fixed NFT spending ceilings are zero, meaning disabled. Purchases must remain affordable from acquisition funds. The bot controls price selection; a compromised bot can overpay an eligible NFT seller.
- Treasury asks 1.1 times recorded gross acquisition cost, rounded up; all NFT sale proceeds fund token buybacks and burns. This treasury resale endpoint is not an OpenSea resale listing.
- One-hour acquisition interval, inventory limit three, 0.01 ETH maximum buyback batch, five-minute buyback interval, 30-minute TWAP and 1% output tolerance.
- Locked token-only liquidity with exactly 2 wei launch value. Deployment gas, bot gas and initial buyer funding are separate. There is no funded ETH exit reserve before buyers trade.

The purchase bot cannot be replaced. Automated execution requires a signer for that exact address; merely entering its public address does not give the process signing access. With no signer, acquisitions can be submitted manually from that wallet but unattended buying will not run. Never put a private key in a launch configuration, public website, source repository or chat. Sharing the controller and bot address also means any imported bot key controls the same wallet's other assets; that is an operational consequence of the chosen address binding.

## Inputs still needed

| Input | Where it goes | Completion condition |
| --- | --- | --- |
| Public website | `metadata.website` | Public credential-free HTTPS page; a private preview is insufficient |
| Public image copy | `metadata.imageUri` | Matching public HTTPS/IPFS/Arweave URI for the selected local PNG bytes |
| Published exact source | `publication.sourceUrl`, `publication.sourceRevision` | Public HTTPS source location and immutable commit containing the actual launch sources and lockfile |
| Programmable API access | `PROGRAMMABLE_API_KEY` environment variable | Ethereum grant and `custom-launch:create` / `custom-launch:read` scopes; wallet key bound to the confirmed controller |
| OpenSea API access | `OPENSEA_API_KEY` environment variable | Real collection listing and fulfillment responses succeed for the actual adapter and treasury |
| Ethereum RPC and bot signer | `CLAUS_RPC_URL`, execution-only `CLAUS_KEEPER_PRIVATE_KEY` | Correct network and signer equals the permanent bot; sufficient bot gas ETH |

No credential values are stored in the reports. The preparation helper reports presence only, which does not establish validity. `.env.example` lists variable names. Node does not load `.env` automatically with the commands below; load variables through the operator's secret service or use Node's explicit `--env-file=.env` option for local operation.

At the final local handoff check on 9 October 2026, `PROGRAMMABLE_API_KEY`, `OPENSEA_API_KEY`, `CLAUS_RPC_URL` and `CLAUS_KEEPER_PRIVATE_KEY` were absent from the process environment. This was a presence-only check; no secret value was printed or authenticated. Recheck the operator environment after configuration rather than treating this dated observation as permanent.

Once OpenSea API access and `CLAUS_FORK_RPC` are configured, the hosted-order verification can run before deployment:

```sh
node scripts/verify-opensea-fork.mjs --capture-pin
node scripts/verify-opensea-fork.mjs --block <captured-number> --hash <captured-hash> --require-restricted
```

This requests a real listing's signed-zone authorization and executes only in an isolated local fork; it accepts no wallet private key and broadcasts nothing to Ethereum. Requiring a restricted order deliberately fails if no supported restricted listing is available. See [the exact scope and evidence rules](FORK-TEST.md#hosted-opensea-order-verification). Configuring `PROGRAMMABLE_API_KEY` alone does not make a missing production package ready: complete public publication inputs and the build/pack steps below, then use the documented official `validate ... --remote` command for authenticated preflight.

Generate a fresh launch nonce and permit timestamps when the exact public package is ready. They are routine package fields, not additional project decisions. Preserve the same nonce and bytes for exact retries. Do not generate and submit a different request to bypass an ambiguous response.

The pinned official CLI's [source-provenance instructions](https://github.com/programmablehq/PROGRAMMABLE/blob/3f5d43fb3787a0b880edc685d5b554dae5074174/packages/launch/README.md#pack-config-v3) describe `publicOrigin.revision` as the Git commit containing the submitted bytes. Its core validator accepts a lowercase 40- or 64-character object ID, but that syntax check does not establish support for substituting a ZIP file's SHA-256 digest. No GitHub-specific host requirement was found. A public source archive can accompany the template; keep the production origin bound to a real publicly retrievable Git commit, and do not claim hosted-archive admission without the official authenticated check.

## Build and review

Use Node `>=24.14.0 <25` for the pinned official CLI 4.1.4. Install and checksum-verify that official release into `artifacts/programmable-cli` before running the packer commands below. The public source snapshot does not include a downloaded CLI or Node runtime.

```sh
npm run check
node scripts/build-launch-graph.mjs --config config/programmable.local.json --out artifacts/production-launch --require-ready
node artifacts/programmable-cli/node_modules/@programmable/launch/bin/programmable-launch.mjs pack --config artifacts/production-launch/programmable-launch.config.json --output artifacts/production-launch/launch.json --receipt artifacts/production-launch/receipt.json
node artifacts/programmable-cli/node_modules/@programmable/launch/bin/programmable-launch.mjs validate artifacts/production-launch/launch.json --config artifacts/production-launch/programmable-launch.config.json
```

Set `officialInputPath` to `../artifacts/production-launch/programmable-launch.config.json` in the local configuration, then run:

```sh
node scripts/prepare-launch.mjs --config config/programmable.local.json --live --rpc-env CLAUS_RPC_URL --out artifacts/production-launch/readiness.json --require-ready
node artifacts/programmable-cli/node_modules/@programmable/launch/bin/programmable-launch.mjs validate artifacts/production-launch/launch.json --config artifacts/production-launch/programmable-launch.config.json --remote
```

The final command is authenticated, side-effect-free platform preflight; it does not reserve a nonce, submit a launch, sign or broadcast. Resolve its exact findings. The token-only start state has zero active liquidity until its first buy crosses the upper range boundary; local buy/sell tests do not guarantee the platform's assessment accepts that state. Do not replace the launch economics silently to satisfy a finding.

After preflight and the exact package review, the official submit command creates the review resource:

```sh
node artifacts/programmable-cli/node_modules/@programmable/launch/bin/programmable-launch.mjs submit artifacts/production-launch/launch.json --config artifacts/production-launch/programmable-launch.config.json
node artifacts/programmable-cli/node_modules/@programmable/launch/bin/programmable-launch.mjs status REQUEST_UUID --watch --until authorized
```

Preserve the official journal and request ID. The current review target is 24 hours, not automatic approval. Approval opens a separate 24-hour execution window; Start launch does not extend it. Controller wallet review must check chain, sender, exact targets, transaction value, calldata and fresh gas estimate. The reviewed launch value is 2 wei; the existing 0.02 ETH gas ceiling is a review budget, not a gas estimate. See the [official guide](https://programmable.market/developers/custom-launch-api-v1.md) for review and recovery. Its older CLI-version examples are superseded by the live 3.6 capabilities and pinned 4.1.4 release.

## Verify the deployment and start the keeper

Copy `config/deployment.example.json` to `config/deployment.local.json`. Fill the five deployed graph addresses from the exact finalized launch, and bind the confirmed bot. Every `runtimeCodeHash` is the keccak256 of runtime bytecode. For the deployed strategy targets, compare actual bytecode with the compiler output after applying the official packer's immutable substitutions. Verify external dependency bytecode and privileges independently before pinning their hashes. Copying hashes from an arbitrary RPC without comparing the intended implementation is not source verification. The template deliberately leaves unverified hashes null, which makes the keeper refuse to operate.

The keeper checks the chain, exact target addresses, runtime hashes, treasury/hook bindings, PoolManager, Seaport, ConduitController, signed zone and bot before execution. It pays no NFT price from the signer wallet: treasury acquisition funds pay the NFT; the signer funds transaction gas.

```sh
node scripts/keeper.mjs --manifest config/deployment.local.json
node scripts/keeper.mjs --manifest config/deployment.local.json --execute
```

The first command is read-only. With OpenSea API access it fetches live orders and simulates atomic registration/purchase, but never signs. The second command is an explicit executing pass: at most one fee flush, one NFT purchase and one buyback. Each transaction's estimated worst-case gas, with 20% gas-limit headroom, must remain below `operator.maxGasCostWei`; this is a bot gas budget and does not reinstate an NFT price ceiling.

Run executing passes from one operator process approximately once per minute, with non-overlapping runs and logged receipts. Funding availability, cooldowns, inventory and TWAP rules decide when work can execute. On a timeout, reconcile pending transactions and current chain state before retrying. OpenSea API failures, canceled listings, unavailable zone authorization and insufficient gas should produce a failed or skipped run, never a price-policy bypass. No hosted keeper service has been deployed by this repository.

Verify one complete real operating cycle: buy and sell the token through the actual route; confirm the 2% treasury fee; flush claims; buy a supported OpenSea listing into treasury; buy that NFT through `buyNFT` at its recorded 1.1-times ask; observe reserved sale proceeds and a successful buyback that reduces token supply. Mainnet actions spend real funds and must use the reviewed wallet transactions. Prior local or fork tests do not substitute for production evidence.

## Public launch availability

The website has its own direct buy/sell route through Ethereum's canonical Uniswap v4 Universal Router, V4Quoter and Permit2. Its actual browser quote and execution functions passed buy and sell integration against those deployed contracts in an isolated Ethereum fork, including the token-only pool's first buy, exact sale allowances, fee accounting and treasury fee flush. See [WEBSITE-TRADING.md](WEBSITE-TRADING.md) and the [retained fork proof](verification/website-trading-fork-proof.json) for scope. The browser checks the exact deployed strategy bindings and runtime hashes, quotes the 2% hook fee, enforces minimum output and expiry, and requires wallet confirmation for each approval or swap. This route does not require Programmable's trading UI to be enabled.

The official [Ethereum capabilities](https://api.programmable.market/v3/capabilities), observed on 9 October 2026, authorize production custom launch profile 3.6.0 but report **onsite trading disabled**, reason `PROVIDER_IDENTITY_CONFIG_MISSING`. The captured response is [programmable-capabilities.json](verification/programmable-capabilities.json). That outage affects Programmable's own trading interface; it does not block the independent website route. Programmable custom-launch admission is still required for the chosen deployment path.

Keep the website in prelaunch mode until deployment finality, actual runtime/source binding and the direct production trade route are verified. The local fork proves the implementation against canonical contracts, not that this coin is already deployed or tradable. A custom coin's optional Programmable detail page uses `https://programmable.market/token/<actual-token-address>?chain=1`; an existing page or finalized stamp does not establish a functioning platform Buy button. Never display a made-up contract address, price, treasury value, burn total or trade link as live data. A private website preview also does not satisfy the launch metadata requirement for a public HTTPS website.

Programmable's [module contribution endpoint](https://programmable.market/developers/module-mode-api-v1.md) is retired. Other creators can reuse this reviewed Custom Launch source template. A newly published selectable module in Programmable's catalog is not currently an available delivery path.
