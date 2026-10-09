# Website trading

The website uses the canonical Ethereum Uniswap v4 Universal Router, V4Quoter,
and Permit2 directly. It does not depend on Programmable's trading UI and does
not add a new strategy contract. The pinned deployment addresses and runtime
hashes are recorded in `config/uniswap.ethereum-release.json`; the browser
module independently pins them in `website/dist/trading.mjs`.

Trading remains disabled when the website configuration says `prelaunch`.
After deployment, the configuration must include the verified token, hook,
treasury, initializer and PoolManager addresses and runtime hashes. Each quote
and execution checks Ethereum chain ID, deployed bytecode, contract bindings,
the initialized locked-liquidity position, the 2% hook fee, 18 token decimals,
and the exact ETH/token pool ID. A configuration change invalidates old quotes.

The quote executes V4Quoter's `quoteExactInputSingle` through `eth_call`, so its
output includes the hook's buy or sell fee. The default user slippage is 1%; the
supported range is 0–5%. Quotes expire after ten minutes. No principal or fee is
spent by asking for a quote.

The transaction contains one `V4_SWAP` command (0x10). Its actions are
`SWAP_EXACT_IN_SINGLE` (0x06), exact `SETTLE` (0x0b), and `TAKE_ALL` (0x0f).
The output goes to the transaction's sender and the minimum output is enforced
onchain. Exact settlement also makes an incomplete input fill revert instead of
silently selling part of the requested amount. The encoder is pinned to the
verified v2 router tuple; newer router interfaces can differ and must not be
substituted without updating the encoder and rerunning integration tests.

Buying uses native ETH without a token approval. Selling requests an ERC20
approval for exactly the sale amount, then a Permit2 router allowance for exactly
that amount expiring with the quote. Each approval and the final swap requires
wallet confirmation. Successful full sales consume both allowances. If a user
cancels after approving, the bounded ERC20 allowance can remain; the router's
Permit2 allowance expires at the displayed quote deadline. There are no infinite
allowances or background wallet signatures.

After any required approvals, the same transaction is simulated again with the
connected account, minimum output and deadline before asking the wallet to send
it. Price movement during confirmation can still make the swap revert. Gas is
paid by the trader. Trading fees accrue as native PoolManager claims and the
permissionless `flushFees` operation sends them only to the treasury; the keeper
also handles this existing step.

## Verification

`test/website-trading.test.mjs` checks disabled prelaunch behavior, dependency
pinning, quote validation and exact command encoding. The optional
`test/website-trading-fork.test.mjs` runs the actual browser module's quote and
execution functions against canonical deployed router, quoter, Permit2 and
PoolManager bytecode inside an isolated Hardhat fork. It also deploys the
strategy's OpenSea adapter against canonical Seaport dependencies and exercises
the exact website export validation chain through the keeper, public snapshot
and trading verifiers. Set
`CLAUS_TRADING_FORK_RPC` to a read-only Ethereum endpoint to run it. It captures
a fresh source block/hash and writes `artifacts/website-trading-fork-proof.json`.
Remote RPC access only supplies state reads; all signatures and transactions are
confined to the independently checked local Hardhat EVM.

`website/test/trading-browser.mjs` separately exercises the real app in Chrome
with delayed quote and execution fixtures. It verifies that changing an amount
discards an in-flight quote, a stale confirmation cannot execute, the signed flow
uses its captured amount, and duplicate submission is blocked until the flow
finishes. Its public evidence is
`docs/verification/website-trading-browser-proof.json`. No wallet or mainnet
transactions are sent by this UI test.

Primary references: [Uniswap deployments](https://developers.uniswap.org/docs/protocols/v4/deployments),
[verified router source](https://etherscan.io/address/0x66a9893cc07d91d95644aedd05d03f95e1dba8af#code),
[v4 swap guide](https://developers.uniswap.org/docs/protocols/v4/guides/swapping/swapping).
