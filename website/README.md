# Claus Strategy website

Buildless, self-hosted assets and JavaScript. The default is an honest prelaunch state: no fabricated token address, live balances, inventory or trade button that submits a transaction.

Run `node server.mjs` from this folder to preview at `http://127.0.0.1:4173`. Run `node --test test/*.test.mjs` for website state checks. `test/browser.mjs` also exercises desktop and mobile navigation, the launch guard, calculator, disclosure and image layout; point `PLAYWRIGHT_MODULE` at an installed Playwright module and use Chrome.

## After the verified coin deployment

From the parent repository, run:

```sh
node scripts/export-website-config.mjs --manifest deployment.json
```

This verifies the treasury, hook, token, initializer, marketplace, external dependencies, pool and public trading route on Ethereum before writing `dist/config.json`. It rejects the undeployed example manifest. It exports only whitelisted public fields and a public RPC URL, never the operator's keys or private RPC URL. Review and republish that exact website version to enable trading. The browser independently checks chain, code hashes and bindings before showing actionable live data.

Coin buys/sells use the verified canonical Uniswap Universal Router and V4 Quoter, with 1% output tolerance, a short deadline and exact-amount sell approvals. This route is independent of Programmable's trading UI. Browser wallet confirmations remain required. NFT purchases call only the fixed treasury's paid sale function and deliver to the connected wallet. No bot signing key or API key belongs in website files.

## Content and assets

The visual design follows Claus's orange/black/cream palette and Bricolage Grotesque font, alongside the four-step strategy explanation and transparent treasury view. Collection artwork and font come from the official public assets referenced by `https://claus.si/about.json`; previews are labelled as collection art, not treasury holdings. Ethers is the pinned 6.15.0 browser distribution with its license.

The page uses `dist/site.css` and `dist/character.mjs`. Its oversized inverted character has pointer-responsive pupils and a brief blink; it is also a normal link to the strategy diagram. The page keeps treasury data and disclosures in the same flat layout, with the example calculator behind a native disclosure. Decorative code never accesses wallets or trading state. The motion toggle and system reduced-motion preference stop character effects. Browser checks cover keyboard navigation, motion preferences and unobstructed controls from narrow phones to desktop.

The project website is public and remains in prelaunch mode. Publishing it publicly does not launch the coin. Production coin deployment, hosted OpenSea verification and operator setup are separate steps. See the parent repository's `docs/PRODUCTION-HANDOFF.md` and `docs/WEBSITE-TRADING.md`.
