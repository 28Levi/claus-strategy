# Launch economics and accepted pricing trust

Revised 9 October 2026 following the user's choices: ContractClaus on OpenSea, 2% buys/sells, no fixed purchase ceiling, and trusted purchase-bot pricing. No mainnet deployment, signature, NFT purchase or liquidity contribution has been made.

## Selected settings

| Setting | Value | Consequence |
| --- | --- | --- |
| Strategy fee | 2% of native ETH on buys/sells in the designated pool | Entire strategy share funds acquisitions. Other pools and wallet transfers are untaxed. |
| Pool LP fee | 0% | Platform routing/protocol fees are separate. |
| NFT price / daily ETH ceiling | None / none; both config values are zero | Rising prices do not require redeployment. |
| Affordability | Available acquisition reserve | Sale proceeds are excluded. |
| Price selection | Immutable trusted bot using supported OpenSea listings | The chain verifies order validity and custody, not a global floor. |
| Purchase interval / inventory | At least 1 hour / at most 3 NFTs | Limits frequency and unsold count, not ETH exposure. |
| Resale | Exactly 1.1 times gross cost, rounded up | Treasury sale endpoint; no guarantee of sale or OpenSea publication. |
| Buyback batch / interval | Up to 0.01 ETH / at least 5 minutes | All proceeds are reserved for eventual batched buybacks. |
| Buyback check | 30-minute pool tick average / 1% output tolerance | Can reject unfavorable execution; not an independent fair-value oracle. |
| Supply | 1 billion tokens assigned to locked initializer | No creator allocation or subsequent minting. |
| Initial native contribution | 2 wei in token-only initializer | Buyers provide pool ETH. Gas/platform charges are additional. |
| Initial upper tick | 175020 | About 39,869,610.83 tokens per ETH, or nominal 25.08 ETH fully diluted quote, not deposited collateral. |

A gross **1.6 ETH** purchase creates a **1.76 ETH** treasury offer. A later supported **3 ETH** listing can be bought once acquisition funds reach 3 ETH, creating a **3.3 ETH** offer. These examples are not live floor quotes. Required marketplace/creator consideration counts toward cost; keeper gas is separate and excluded from markup.

At 2%, accumulating 1.6 ETH from fees alone requires approximately 80 ETH of taxable trading value; accumulating 3 ETH requires about 150 ETH. This is arithmetic, not a volume forecast. Donations and Claus holding rewards may also fund acquisitions.

## Pricing trust

The keeper requests OpenSea's best collection listings, validates typed signed orders, selects supported affordable candidates, and simulates atomic registration/purchase. Its bounded API scan cannot prove that no cheaper order exists elsewhere. WETH, bundles, partial fills and variable-price orders are unsupported.

The bot address is fixed at launch. There is no admin price setter, bot rotation, withdrawal or NFT approval path. However, a dishonest or compromised bot **can overpay its own listing and extract acquisition ETH**. The user explicitly accepted that risk; describing the whole strategy as unconditionally unruggable would be false. Losing the key stops acquisitions. Fee settlement, paid resales and eligible buybacks retain public execution paths.

## Reference evidence and correction

The earlier 0.20 ETH cap used the underlying 50,000 CLAUS tokens, not OpenSea's NFT floor. It was an inappropriate ceiling for the intended strategy and is removed. The intermediate 1.6 ETH ceiling is also removed because it would stop purchases as prices rise.

Historical [Claus documentation](https://claus.si/read/Hooks/NFTs) and reads at block 26,154,378 showed native-market asks of 4.8 and 5 ETH and a simulated underlying-token sale quote near 0.1744 ETH. These describe another market and collateral comparison, not OpenSea's current floor or this strategy's policy. [Raw historical snapshot](verification/economics-snapshot-2026-10-09.json).

The [PunkStrategy website](https://www.punkstrategy.fun/#how-it-works) describes fee-funded purchases, 1.1x resale and buybacks. Its [original verified source](https://etherscan.io/address/0xc50673EDb3A7b94E8CAD8a7d4E0cD68864E33eDF#code) establishes the 2-wei token-only launch mechanism, with a nominal opening quote around 25 ETH for a billion tokens. That does not mean 25 ETH was deposited; sell liquidity depends on buyers supplying ETH.

The [PunkStrategy patch](https://etherscan.io/address/0x1244eae9fa2c064453b5f605d708c0a0bfba4838#code) accepts caller-selected public listings above a 6.9 ETH minimum when funds suffice. It does not enforce a collection floor and retains privileged withdrawal/configuration paths. Its economic loop is a reference, not evidence for developer-proof custody or pricing. See [reference review](REFERENCE-REVIEW.md).

## Launch costs and validation

Two wei is not a total launch budget. Deploying five contracts, establishing liquidity and launching costs gas. The bot needs gas funding and an OpenSea API key. No live bot, admitted-package gas quote or confirmed service bill exists.

Programmable's Custom Launch source route is used because new catalog module submissions are retired. Platform admission, public source provenance, trading availability and exact runtime verification remain separate requirements. The reusable source template is not a completed public launch.
