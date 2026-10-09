# Claus fork integration evidence

`test/fork.test.mjs` passed on 9 October 2026 using public Ethereum reads and an isolated, in-process Hardhat fork. No transaction was signed for or broadcast to Ethereum. The external RPC only supplied historical chain state; all deployment, funding, impersonation, purchases and sales happened in the local EVM.

The immutable test pin is Ethereum block **26,154,369**, hash `0xe37b850c5c182cdf1b868af39bcf2606d9ae52a9213e5b42a1004e99ff0269d7`.

| Contract | Address | Runtime keccak256 at the pinned block |
| --- | --- | --- |
| Claus NFT | `0x80396c7131159eB92E7E84839e51C9887A7A95d9` | `0x162a8f628e26a75e99b59459595aa3dab79d928bab90263195364a48d91a8212` |
| Claus NFT market | `0x7832B1B34B8dBec979a44634BC095821c91FFc95` | `0x63865e754617b5ee85e3da800d2de79fe5728eacc9573ce0d560f37e5e8ee2a3` |

The legacy test checks these runtime hashes, the exact block hash, the collection address against the launch template, and the native market's collection binding. The current launch template instead uses the OpenSea adapter. The pinned legacy addresses correspond to [the collection's verified code](https://etherscan.io/address/0x80396c7131159eB92E7E84839e51C9887A7A95d9#code) and [the market's verified code](https://etherscan.io/address/0x7832B1B34B8dBec979a44634BC095821c91FFc95#code).

Verified sequence:

1. Deploy the strategy token, treasury and mock fee/buyback executor locally. Use the real deployed Claus NFT collection and marketplace from the fork.
2. Impersonate the existing owner of Claus #1 locally, approve the real marketplace, and list at 0.1 ETH. This makes the test independent of an existing seller keeping a listing open.
3. Fund the treasury through its fee endpoint and purchase the NFT. Assert custody, updated transfer nonce, automatic 0.11 ETH resale price, and zero treasury approvals. A developer-account transfer attempt fails.
4. Advance the local clock through the real reward epoch. The actual Claus reward contracts pay **0.001849249337010874 ETH** from their existing funded reward pot to the treasury's acquisition budget. No reward code, storage or balances were replaced or artificially injected.
5. Buy the NFT from the treasury for 0.11 ETH. Assert that every sale wei enters the buyback budget, the historical holding checkpoint stops accruing, the new owner starts accruing, and treasury accounting equals its native balance.

The test deliberately uses a mock strategy executor to isolate NFT and reward compatibility. The separate v4 tests cover swaps, hook fees and buyback/burn execution with the real local PoolManager implementation. This fork result does not establish Programmable admission or a production launch.

Run in PowerShell with an Ethereum archive RPC that can serve the pinned block:

```powershell
$env:CLAUS_FORK_RPC = 'https://your-ethereum-archive-rpc'
node --test test/fork.test.mjs
```

Without `CLAUS_FORK_RPC`, the test explicitly skips and the offline suite remains deterministic. The successful run used `https://ethereum-rpc.publicnode.com` while this pin was recent. Publicnode rejected the older 6 October snapshot with “Archive requests require a personal token”; reproducing this now-historical pin may require an archive-capable endpoint. The test fails, rather than reporting success or silently selecting another block, when its explicit RPC cannot serve the pin.

## Canonical Seaport acquisition fork

`test/seaport-fork.test.mjs` **passed on 9 October 2026** against the actual Ethereum Seaport 1.6 deployment, its ConduitController and the real Claus collection. This is separate from the successful legacy native-market fixture above and from the offline tests that deploy Seaport source locally.

The Seaport test explicitly pins block **26,154,629**, hash `0x5e813eb256463c52afae70691c051b31fb16471881e32e4e74c471dd4c17d0e0`. The pin was advanced from 26,154,369 after Publicnode's historical state limit rejected that older block. The new pin's collection bytecode was checked against the same reviewed runtime hash before running; the test never silently selects a different block. Ethereum is the source chain (1), while the synthetic-order test executes on local Hardhat chain 31337.

The fixture checks the pinned block and Claus runtime hash, requires deployed code at the release-pinned Seaport, ConduitController and OpenSea signed-zone addresses, and verifies Seaport's reported version and controller binding. It deploys only the strategy components and mock fee executor locally. It then impersonates the current owner of real Claus #1 inside Hardhat, transfers the NFT to a fresh local seller wallet, creates a local conduit through the canonical controller and signs a **synthetic `FULL_OPEN` order** for 1.6 ETH, including a 0.04 ETH fee.

Passing assertions cover trusted-bot authorization, zero/no-ceiling settings, payment through canonical Seaport and its conduit, exact seller and fee payments, full order fulfillment, treasury ownership, absent NFT withdrawal approvals, replay rejection and resale at 1.76 ETH credited only to the buyback reserve. The actual OpenSea signed zone rejects a seller-signed restricted order carrying fake zone authorization. That negative check does not prove that the hosted API will issue a valid authorization for the adapter. The external RPC receives historical reads only. Neither the generated seller key nor any signed transaction is sent to Ethereum.

```powershell
$env:CLAUS_FORK_RPC = 'https://your-ethereum-archive-rpc'
node --test test/seaport-fork.test.mjs
```

Evidence is retained in [the TAP result](verification/seaport-fork-tests.tap) and [the fork proof](verification/seaport-fork-test-proof.json), including observed dependency code hashes and the scope of its assertions. The extended canonical-conduit test passed in about 140 seconds. The fixture remains explicit opt-in and skips without `CLAUS_FORK_RPC`. Once this pin ages out of a public endpoint's recent-state window, reproduction needs archive access; the test fails instead of advancing its pin. A new successful run also writes `artifacts/seaport-fork-test-proof.json`.

Even a successful run uses a synthetic local order, not a live OpenSea listing. It does not exercise the hosted OpenSea API or OpenSea's signed-zone authorization. Those remain separate checks requiring API access and a suitable live listing. No proof file is produced for a skipped or failed run.

The canonical PoolManager and Programmable GraphFactory runtime hashes were also read at the same block and matched the release pins. That separate read-only evidence is retained in [platform-runtime-proof.json](verification/platform-runtime-proof.json).

## Hosted OpenSea order verification

`scripts/verify-opensea-fork.mjs` fetches a real current OpenSea listing and its buyer-bound fulfillment payload, then executes it only in a new local Hardhat fork. It checks the reviewed external runtime hashes, bot authorization, exact gross acquisition cost, custody, replay rejection and paid 1.1x resale. The fee executor is a local mock; v4 fee and burn behavior remains covered by the independent local integration tests.

The command requires `CLAUS_FORK_RPC` and `OPENSEA_API_KEY` in the local environment. It accepts no private key and no API key on its command line. First capture a recent block, then explicitly pass its number and hash:

```powershell
node scripts/verify-opensea-fork.mjs --capture-pin
node scripts/verify-opensea-fork.mjs --block <captured-number> --hash <captured-hash>
```

`--capture-pin` needs only the RPC and reads the chain ID and latest block header; it does not create a success proof or choose a new pin behind an existing verification run. The second command requires the exact pin, checks it against the RPC and fails if it differs. Add `--require-restricted` to require a real restricted order with hosted signed-zone authorization; a collection with no supported restricted listing will fail that mode instead of claiming coverage.

The real-order fork deliberately uses **chain ID 1 locally** so Ethereum maker and signed-zone signatures remain valid. Safety checks require Hardhat's `edr-simulated` network and Hardhat client version before any signer is obtained. All signers come from that in-process provider; no external transaction provider or wallet key is used. Both deployments and the purchase/resale transactions are local, despite the Ethereum signature domain. The external RPC supplies reads and OpenSea supplies an unsigned fulfillment payload.

A successful run writes `artifacts/opensea-live-fork-proof.json`. It records the exact pin, order hash, price, gas, reviewed runtime hashes and whether signed-zone authorization was actually exercised. It omits API credentials, RPC URLs, seller signatures and raw API payloads. A failed run produces no new success proof; inspect timestamps when retaining earlier evidence.

**Current status:** argument/credential gates and remote chain/header validation have two passing tests, and block capture was checked against the real public RPC. Authenticated order discovery and fulfillment remain unexecuted because no OpenSea API key is configured. Neither this command's existence nor its input tests count as successful hosted OpenSea fulfillment.
