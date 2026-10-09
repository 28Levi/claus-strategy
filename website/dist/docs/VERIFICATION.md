# Verification completed 9 October 2026

Final offline result: **76 passed, 0 failed, 3 optional network fork tests skipped** (79 total). The complete output is retained in [offline-tests.tap](verification/offline-tests.tap). Separate network-fork evidence is described below. No mainnet deployment, wallet signature or transaction was made.

## Build and tests

- Node 24.14.0, Hardhat 3.18.1, isolated Cancun EVM.
- Strategy contracts: Solidity 0.8.26, optimizer 200, viaIR, Cancun, metadata hash disabled; production runtimes fit EIP-170.
- Actual Uniswap v4 PoolManager from pinned v4-core 1.0.2.
- Actual Seaport 1.6 from pinned seaport-core 1.6.6 / seaport-types 1.6.3. Test dependencies compile separately with Solidity 0.8.24 and Seaport's 4,294,967,295-run optimizer setting. Seaport runtime: 23,981 bytes. Strategy compilation settings are unchanged.
- Command: `node --test --test-concurrency=1 --test-reporter=tap test/*.test.mjs`.

| Area | Passing tests | Evidence |
| --- | ---: | --- |
| Balanced initializer | 7 | Entire supply allocated, locked position, atomic failure rollback |
| Token-only initializer | 4 | Exact two-wei launch, first buy from zero ETH, buy/sell fees |
| Treasury | 9 | Paid resale, burn, reserve separation, optional capped template mode |
| V4 hook/oracle | 4 | Real swaps, fee deltas, historical output minimum, callback restrictions |
| Adversarial accounting/callbacks | 5 | Reentrancy, dishonest executor, forced ETH, rejected delivery |
| Keeper | 6 | Bot simulation/execution, stale-order fallback, affordability, gas ceilings, exact dependency/bot manifest |
| Programmable graphs | 7 | Five targets, bot binding, uncapped settings, actual official packing in both modes |
| Readiness/schema | 8 | Missing inputs, private-public metadata boundary, mismatched chains, stale capabilities, schema rejection |
| OpenSea API client | 11 | Typed Basic/Advanced/ordinary orders, Address-wrapped recipient, exact wei parsing, hostile response rejection, bounded requests |
| Actual local Seaport | 6 | Signed purchase including fees, real conduit, zone fulfiller, atomic failure rollback, custody/resale/burn, uncapped higher prices |
| Hosted OpenSea fork inputs | 2 | Explicit block/hash and credentials required before hosted fulfillment checks |
| Website trading | 6 | Prelaunch guard, exact router encoding, dependency pinning, amount/deadline validation |
| Website configuration export | 1 | Undeployed template rejection and public-field whitelist |

The restricted-zone fixture checks that Seaport's fulfiller is the adapter, not the treasury. It is a test zone, not OpenSea's deployed signed-zone implementation. API responses are schema-shaped fixtures, not authenticated live responses.

## Complete local flow

`node scripts/demo.mjs` passed with the selected token-only launch, no fixed purchase/daily ceiling, 1% buyback tolerance, one-hour purchase interval and three-NFT inventory limit:

- 2 wei launch value, permanently locked initial position, 0% LP fee.
- 100 ETH local test buy; 2 ETH strategy fees settled into acquisition funds.
- Signed restricted Seaport order: 1.6 ETH gross cost, including 0.04 ETH consideration fee; NFT delivered directly to treasury.
- Acquisition transaction: 2,471,460 gas in this local fixture; not a mainnet gas quote.
- Treasury resale: 1.76 ETH, entirely assigned to buybacks.
- First 0.01 ETH buyback burned 16,555.234093021386128005 strategy tokens, decreasing totalSupply by that amount.
- Remaining balances: 0.4 ETH acquisitions and 1.75 ETH reserved for later buyback batches; combined treasury ETH 2.15.

[Retained demo report](verification/demo-report.json). The NFT and restricted zone are mocks; the PoolManager and Seaport are real implementations. Other tests acquired at 2.4 ETH and 3 ETH with zero fixed ceilings, while unauthorized purchases and spending sale reserves were rejected. These are test amounts, not live floor observations.

## Launch packing

Both token-only and balanced five-contract graphs passed actual checksum-verified `@programmable/launch` 4.1.4 packing on Ethereum profile 3.6.0. Tests verify exact source inputs, constructor/runtime immutables, bot address, zero purchase/daily ceilings, funding and hook mask 0x30cc.

- [Token-only packing proof](verification/launch-graph-token-only-test-proof.json)
- [Balanced packing proof](verification/launch-graph-balanced-test-proof.json)

Packing used synthetic identity, image, bot and source metadata. It proves local graph compatibility, not published provenance, platform admission or deployment. The actual launch controller and permanent bot are confirmed; operator configuration is excluded from the public repository. The website is now public and prelaunch. Production packing against the exact published source commit, authenticated admission, deployment and bot operation remain separate requirements.

## Fork and live boundaries

A previous legacy native-market fork test passed against the real Claus collection, market and holding rewards at Ethereum block 26,154,369. It is historical compatibility evidence, not an OpenSea test. Optional network fork tests are skipped in the offline suite and have separate retained results.

The canonical Seaport plus real Claus fork test **passed** at Ethereum block **26,154,629**, hash `0x5e813eb256463c52afae70691c051b31fb16471881e32e4e74c471dd4c17d0e0`. It used the real collection, deployed Seaport, its deployed conduit controller, a real controller-created conduit, and a synthetic locally signed order. Purchase at 1.6 ETH and resale at 1.76 ETH passed; unauthorized purchases, replay and invalid authorization for OpenSea's deployed signed zone were rejected. All state changes occurred only in a local Hardhat EVM. [Retained fork proof](verification/seaport-fork-test-proof.json), [test output](verification/seaport-fork-tests.tap), [scope and reproduction](FORK-TEST.md).

Rejecting invalid signed-zone authorization does not prove successful hosted authorization. `scripts/verify-opensea-fork.mjs` is an opt-in verifier for a real OpenSea API listing and fulfillment response, with a required explicit source block/hash and local-EVM checks. It refuses to run fulfillment without a locally configured API key. That authenticated verification remains pending.

## Website and trading

The website includes responsive desktop/mobile layouts, the selected project X profile, collection previews, exact-wei resale arithmetic, treasury inventory/activity reads, explicit custody/pricing disclosures, and disabled prelaunch wallet actions. It displays no invented deployed addresses, balances or NFT holdings. The launch wallet is identified separately from the absent token address.

Four website state tests passed. The final sparse layout passed Chrome checks at 320, 390, 768 and 1440 pixels, including navigation, calculator disclosure, reduced-motion changes, character behavior and unobstructed controls. See [the final layout proof](verification/website-sparse-browser-proof.json). Earlier desktop/mobile checks also covered launch guards, contract identity and image layout. A separate delayed-response Chrome test passed for stale quote rejection, captured trade amount, duplicate submission prevention and control restoration. [Browser interaction proof](verification/website-browser-proof.json), [trading browser proof](verification/website-trading-browser-proof.json).

The actual browser quote and execute functions passed buy and sell tests against Ethereum's deployed Universal Router, V4Quoter, Permit2 and PoolManager in an isolated fork at block **26,154,757**, hash `0x6283433cc566197b05683a9a0391aabbf53a0ef1d82a3cfdb0a3bf5db8bd0030`. The first token-only buy worked; actual outputs equaled the fee-inclusive quotes; sell input and allowances were exact; 2% fees reached the treasury; stale quotes, wrong code and impossible minimum output were rejected. No mainnet transaction occurred. [Retained trading fork proof](verification/website-trading-fork-proof.json), [route and reproduction](WEBSITE-TRADING.md).

The configuration exporter verifies deployed contracts and trading dependencies before changing the site from prelaunch to live. It exports only public fields and a public RPC URL. Final review found and fixed a missing initializer getter in its treasury ABI. The exact exporter validation path then passed against the same canonical fork, including keeper, public-state and trading checks; all six affected focused checks passed (exporter, fork and four state tests). Actual production deployment and production trading remain unverified.

## Remaining production boundaries

No OpenSea API key is configured, so authenticated live listing discovery and signed-zone fulfillment remain unverified. No live bot, independent audit, mainnet launch, production admission or deployed strategy trading route is claimed. Uncapped pricing trusts the immutable bot, as explicitly selected by the user; custody tests do not prove that a dishonest bot cannot overpay.

Programmable new catalog submissions are retired. This is a reusable Custom Launch source template, not an installed catalog module. Its onsite trading currently reports disabled; the tested independent website route uses Uniswap directly. Current platform admission must still succeed before the chosen launch path can proceed. Treasury resale remains its paid endpoint and is not automatically published on OpenSea. See [production handoff](PRODUCTION-HANDOFF.md).
