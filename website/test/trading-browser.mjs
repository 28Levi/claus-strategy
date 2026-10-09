import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  const config = JSON.parse(await fs.readFile(new URL('../dist/config.json', import.meta.url), 'utf8'));
  const stateSource = await fs.readFile(new URL('../dist/state.mjs', import.meta.url), 'utf8');
  config.status = 'live'; config.rpcUrl = 'https://example.test';
  config.contracts = Object.fromEntries(['treasury', 'token', 'hook', 'market', 'initializer', 'poolManager', 'collection', 'seaport', 'conduitController', 'allowedZone']
    .map(role => [role, { address: config.collection, runtimeCodeHash: `0x${'11'.repeat(32)}` }]));
  config.trading = { dependencies: {} };
  // Only the external snapshot/quote/wallet boundary is mocked. The real app
  // handles delayed responses, invalidation, duplicate submissions and rendering.
  await page.route('**/config.json', route => route.fulfill({ json: config }));
  await page.route('**/state.mjs', route => route.fulfill({ contentType: 'text/javascript', body:
    stateSource.replace('export async function loadSnapshot(', 'async function unusedOriginalLoadSnapshot(')
    + '\nexport async function loadSnapshot(){return{block:1,acquisitions:0n,buybacks:0n,inventoryCount:0n,burned:0n,inventory:[],activity:[],activityUnavailable:false};}' }));
  await page.route('**/trading.mjs', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.pendingQuotes=[];window.executedTrades=[];window.ethereum={request:()=>{throw new Error('No real wallet requests allowed in UI race test');}};
    export async function quoteTrade(request){return new Promise(resolve=>window.pendingQuotes.push({request,resolve}));}
    export async function executeTrade(request){window.executedTrades.push(request.quote);return new Promise(resolve=>window.resolveTrade=resolve);}
  ` }));
  await page.goto('http://127.0.0.1:4173', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Buy $CLSTR' }).click();
  assert.equal(await page.locator('#trade-dialog').isVisible(), true);
  const input = page.locator('#trade-amount'), submit = page.getByRole('button', { name: 'Get a quote ↗' });
  const resolveQuote = index => page.evaluate(i => {
    const pending = window.pendingQuotes[i];
    pending.resolve({ amountInWei: (BigInt(pending.request.amount) * 10n ** 18n).toString(), amountOutWei: '10000000000000000000', minOutWei: '9900000000000000000' });
  }, index);
  await input.fill('1'); await submit.click();
  await page.waitForFunction(() => window.pendingQuotes?.length === 1);
  await input.fill('2'); await resolveQuote(0);
  await page.waitForFunction(() => !document.querySelector('#trade-form button[type=submit]').disabled);
  assert.equal(await page.locator('#trade-quote').isVisible(), false, 'Delayed quote must stay hidden after amount changes');
  await submit.click(); await page.waitForFunction(() => window.pendingQuotes.length === 2); await resolveQuote(1);
  await page.locator('#trade-quote button').waitFor({ state: 'visible' });
  await page.evaluate(() => window.oldConfirm = document.querySelector('#trade-quote button'));
  await input.fill('3');
  await page.evaluate(() => window.oldConfirm.click());
  assert.equal(await page.evaluate(() => window.executedTrades.length), 0, 'A detached stale confirmation must never execute');
  assert.match(await page.locator('#trade-feedback').innerText(), /no longer current/);
  await submit.click(); await page.waitForFunction(() => window.pendingQuotes.length === 3); await resolveQuote(2);
  await page.locator('#trade-quote button').click();
  await page.waitForFunction(() => window.executedTrades.length === 1);
  assert.equal(await input.isDisabled(), true);
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await page.locator('[name=direction]').first().isDisabled(), true);
  await page.evaluate(() => document.querySelector('#trade-form').dispatchEvent(new Event('submit', { cancelable: true })));
  assert.equal(await page.evaluate(() => window.pendingQuotes.length), 3, 'A signing flow must not start a second quote request');
  assert.equal(await page.evaluate(() => window.executedTrades[0].amountInWei), '3000000000000000000');
  await page.evaluate(() => window.resolveTrade({ hash: `0x${'22'.repeat(32)}` }));
  await page.waitForFunction(() => !document.querySelector('#trade-amount').disabled);
  assert.equal(await page.locator('#trade-quote').isVisible(), false);
  assert.match(await page.locator('#trade-feedback').innerText(), /Trade confirmed/);
  assert.deepEqual(errors, []);
  const proof = { checkedAt: new Date().toISOString(), scope: 'real app DOM with mocked delayed snapshot/quote/execution boundaries',
    staleQuoteDiscarded: true, staleConfirmationRejected: true, capturedAmountVerified: true,
    duplicateSigningFlowBlocked: true, controlsRestored: true, pageErrors: errors, realWalletTransactions: false };
  await fs.mkdir(new URL('../../artifacts/website/', import.meta.url), { recursive: true });
  await fs.writeFile(new URL('../../artifacts/website/trading-browser-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
} finally { await browser.close(); }
