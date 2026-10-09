import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, ZeroHash } from 'ethers';
import { computeSeaportOrderHash, fetchBestListingOrders, normalizeOpenSeaFulfillment,
  OPENSEA_SIGNED_ZONE, SEAPORT_1_6 } from '../scripts/opensea.mjs';

// Synthetic fixtures shaped after official OpenAPI schemas, not captured live orders:
// https://api.opensea.io/api/v2/openapi.json (Listing, FullfillListingRequest,
// FulfillListingResponse, TransactionData, FulfillAdvancedOrder, FulfillBasicOrder, FulfillOrder).
// Basic routes: https://github.com/ProjectOpenSea/seaport-types/blob/main/src/lib/ConsiderationEnums.sol
const collection = '0x1111111111111111111111111111111111111111';
const seller = '0x2222222222222222222222222222222222222222';
const market = '0x3333333333333333333333333333333333333333';
const treasury = '0x4444444444444444444444444444444444444444';
const feeRecipient = '0x5555555555555555555555555555555555555555';
const NOW = 1_800_000_000;
const GROSS = 1_600_000_000_000_000_000n;
const options = { collectionAddress: collection, marketAddress: market, treasuryAddress: treasury,
  seaportAddress: SEAPORT_1_6, collectionSlug: 'contractclaus', nowSeconds: NOW };
const signature = '0x' + 'ab'.repeat(65);

function fixture({ price = GROSS, tokenId = '42', restricted = false, shape = 'advanced' } = {}) {
  const fee = 40_000_000_000_000_000n;
  const p = {
    offerer: seller, zone: restricted ? OPENSEA_SIGNED_ZONE : ZeroAddress,
    offer: [{ itemType: 2, token: collection, identifierOrCriteria: tokenId, startAmount: '1', endAmount: '1' }],
    consideration: [
      { itemType: 0, token: ZeroAddress, identifierOrCriteria: '0', startAmount: String(price - fee), endAmount: String(price - fee), recipient: seller },
      { itemType: 0, token: ZeroAddress, identifierOrCriteria: '0', startAmount: String(fee), endAmount: String(fee), recipient: feeRecipient },
    ],
    orderType: restricted ? 2 : 0, startTime: String(NOW - 100), endTime: String(NOW + 3600),
    zoneHash: ZeroHash, salt: '9', conduitKey: ZeroHash, counter: '7', totalOriginalConsiderationItems: 2,
  };
  const listing = { chain: 'ethereum', status: 'ACTIVE', type: 'basic', remaining_quantity: 1,
    order_hash: computeSeaportOrderHash(p), protocol_address: SEAPORT_1_6,
    protocol_data: { parameters: structuredClone(p), signature: null }, asset: { contract: collection, identifier: tokenId },
    price: { current: { currency: 'ETH', decimals: 18, value: String(price) } } };
  const advancedOrder = { parameters: structuredClone(p), numerator: 1, denominator: 1,
    signature, extraData: restricted ? '0xaabb' : '0x' };
  const transaction = { chain: 1, to: SEAPORT_1_6, value: String(price), function: 'fulfillAdvancedOrder',
    input_data: { advancedOrder, criteriaResolvers: [], fulfillerConduitKey: ZeroHash, recipient: treasury } };
  if (shape === 'order') {
    transaction.function = 'fulfillOrder';
    transaction.input_data = { order: { parameters: structuredClone(p), signature }, fulfillerConduitKey: ZeroHash };
  } else if (shape === 'basic') {
    transaction.function = 'fulfillBasicOrder';
    transaction.input_data = { parameters: {
      considerationToken: ZeroAddress, considerationIdentifier: '0', considerationAmount: String(price - fee),
      offerer: seller, zone: p.zone, offerToken: collection, offerIdentifier: tokenId, offerAmount: '1',
      basicOrderType: p.orderType, startTime: p.startTime, endTime: p.endTime, zoneHash: p.zoneHash,
      salt: p.salt, offererConduitKey: p.conduitKey, fulfillerConduitKey: ZeroHash,
      totalOriginalAdditionalRecipients: 1, additionalRecipients: [{ amount: String(fee), recipient: feeRecipient }], signature,
    } };
  }
  return { listing, fulfillment: { protocol: 'seaport', fulfillment_data: {
    orders: [{ parameters: structuredClone(p), signature }], transaction,
  } } };
}
const normalize = f => normalizeOpenSeaFulfillment({ ...options, ...f });
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });

test('normalizes advanced, basic and ordinary Seaport ETH orders without forwarding API transactions', () => {
  for (const shape of ['advanced', 'basic', 'order']) {
    const f = fixture({ shape });
    const input = f.fulfillment.fulfillment_data.transaction.input_data;
    // An untrusted buyer conduit is discarded, not passed to the adapter or approved.
    (shape === 'basic' ? input.parameters : input).fulfillerConduitKey = '0x' + '99'.repeat(32);
    const result = normalize(f);
    assert.equal(result.tokenId, 42n);
    assert.equal(result.priceWei, GROSS);
    assert.equal(result.counter, 7n);
    assert.equal(result.orderHash, f.listing.order_hash);
    assert.equal(result.advancedOrder.parameters.consideration.length, 2);
    assert.equal(result.advancedOrder.parameters.consideration[1].recipient, feeRecipient);
    assert.equal(result.advancedOrder.numerator, 1);
    assert.equal(result.advancedOrder.denominator, 1);
    assert.ok(!('transaction' in result) && !('to' in result) && !('calldata' in result));
    assert.deepEqual(Object.keys(result.advancedOrder).sort(), ['denominator', 'extraData', 'numerator', 'parameters', 'signature']);
  }
  const efficient = fixture({ shape: 'basic' });
  efficient.fulfillment.fulfillment_data.transaction.function = 'fulfillBasicOrder_efficient_6GL6yc';
  assert.equal(normalize(efficient).priceWei, GROSS);
});

test('preserves buyer-bound restricted zone data and rejects absent or wrong-zone authorization', () => {
  const f = fixture({ restricted: true });
  assert.equal(normalize(f).advancedOrder.extraData, '0xaabb');
  f.fulfillment.fulfillment_data.transaction.input_data.advancedOrder.extraData = '0x';
  assert.throws(() => normalize(f), /fresh zone authorization/);
  const wrongZone = fixture({ restricted: true });
  wrongZone.listing.protocol_data.parameters.zone = feeRecipient;
  assert.throws(() => normalize(wrongZone), /Unsupported restricted zone/);
});

test('normalizes OpenAPI Address-wrapper recipients while still pinning the treasury address', () => {
  const f = fixture();
  f.fulfillment.fulfillment_data.transaction.input_data.recipient = {value:treasury,typeAsString:'address'};
  assert.equal(normalize(f).priceWei,GROSS);
  f.fulfillment.fulfillment_data.transaction.input_data.recipient = {value:seller,typeAsString:'address'};
  assert.throws(() => normalize(f),/Unexpected NFT recipient/);
  f.fulfillment.fulfillment_data.transaction.input_data.recipient = {value:treasury,typeAsString:'bytes20'};
  assert.throws(() => normalize(f),/Invalid NFT recipient/);
});

test('uses the complete signed price, an optional cash budget and no hardcoded floor cap', () => {
  assert.equal(normalize(fixture({ price: 8n * 10n ** 18n })).priceWei, 8n * 10n ** 18n);
  assert.equal(normalizeOpenSeaFulfillment({ ...options, ...fixture(), maxPriceWei: GROSS }).priceWei, GROSS);
  assert.throws(() => normalizeOpenSeaFulfillment({ ...options, ...fixture(), maxPriceWei: GROSS - 1n }), /cap including all fees/);
  const f = fixture();
  f.listing.price.current.value = String(GROSS - 40_000_000_000_000_000n);
  assert.throws(() => normalize(f), /Displayed price differs/);
});

test('rejects mismatched targets, recipients, hashes, asset IDs, value, signatures and unsupported selectors', () => {
  const cases = [
    [f => { f.fulfillment.fulfillment_data.transaction.to = seller; }, /target/],
    [f => { f.fulfillment.fulfillment_data.transaction.chain = 8453; }, /chain/],
    [f => { f.fulfillment.fulfillment_data.transaction.input_data.recipient = seller; }, /recipient/],
    [f => { f.fulfillment.fulfillment_data.transaction.input_data.recipient = ZeroAddress; }, /recipient/],
    [f => { f.listing.order_hash = ZeroHash; }, /order hash mismatch/],
    [f => { f.listing.asset.identifier = '999'; }, /asset mismatch/],
    [f => { f.listing.chain = 'base'; }, /Ethereum/],
    [f => { f.listing.price.current.currency = 'WETH'; }, /must be ETH/],
    [f => { f.fulfillment.fulfillment_data.transaction.value = String(GROSS + 1n); }, /value/],
    [f => { f.fulfillment.fulfillment_data.transaction.input_data.advancedOrder.parameters.salt = '10'; }, /order hash mismatch/],
    [f => { f.fulfillment.fulfillment_data.orders[0].parameters.counter = '8'; }, /metadata order hash mismatch/],
    [f => { f.fulfillment.fulfillment_data.orders[0].signature = '0xff'; }, /signature mismatch/],
    [f => { f.fulfillment.fulfillment_data.transaction.function = 'fulfillAdvancedOrder(address)'; }, /Unsupported fulfillment function/],
    [f => { f.fulfillment.fulfillment_data.transaction.function = 'matchAdvancedOrders'; }, /Unsupported fulfillment function/],
    [f => { f.fulfillment.fulfillment_data.transaction.input_data.advancedOrder.denominator = 2; }, /Partial fills/],
    [f => { f.fulfillment.fulfillment_data.transaction.input_data.criteriaResolvers = [{}]; }, /Criteria/],
    [f => { f.listing.protocol_data.parameters.endTime = String(NOW); }, /not active/],
    [f => { f.listing.protocol_data.parameters.offer[0].token = seller; }, /configured collection/],
    [f => { f.listing.protocol_data.parameters.consideration[0].endAmount = String(GROSS); }, /fixed positive/],
    [f => { f.listing.protocol_data.parameters.consideration[0].token = seller; }, /native ETH/],
    [f => { f.listing.protocol_data.parameters.orderType = 1; }, /full open/],
    [f => { f.listing.protocol_data.parameters.totalOriginalConsiderationItems = 1; }, /Unsigned consideration/],
  ];
  for (const [mutate, pattern] of cases) {
    const f = fixture(); mutate(f);
    assert.throws(() => normalize(f), pattern);
  }
});

test('rejects unsafe numbers, oversized signatures and basic-order routes/tips', () => {
  const f = fixture(); f.listing.price.current.value = Number(GROSS);
  assert.throws(() => normalize(f), /Invalid listing price/);
  const badRoute = fixture({ shape: 'basic' });
  badRoute.fulfillment.fulfillment_data.transaction.input_data.parameters.basicOrderType = 8;
  assert.throws(() => normalize(badRoute), /ETH to ERC721/);
  const tips = fixture({ shape: 'basic' });
  tips.fulfillment.fulfillment_data.transaction.input_data.parameters.totalOriginalAdditionalRecipients = 0;
  assert.throws(() => normalize(tips), /Unsigned consideration/);
  const big = fixture();
  big.fulfillment.fulfillment_data.transaction.input_data.advancedOrder.signature = '0x' + 'aa'.repeat(4097);
  assert.throws(() => normalize(big), /signature is too large/);
});

test('discovery requests the adapter as fulfiller and treasury as NFT recipient, selecting the cheapest valid candidate', async () => {
  const cheap = fixture(), costly = fixture({ price: 2n * GROSS, tokenId: '43' });
  const requests = [];
  const result = await fetchBestListingOrders({ ...options, apiKey: 'local-test-only', fetchImpl: async (url, init) => {
    requests.push({ url, init });
    assert.equal(new URL(url).origin, 'https://api.opensea.io');
    assert.equal(init.redirect, 'error');
    if (init.method === 'GET') return json({ listings: [costly.listing, cheap.listing], next: null });
    const body = JSON.parse(init.body);
    assert.deepEqual(body.fulfiller, { address: market });
    assert.equal(body.recipient, treasury);
    assert.equal(body.listing.hash, cheap.listing.order_hash);
    assert.equal(body.listing.chain, 'ethereum');
    assert.equal(body.listing.protocol_address, SEAPORT_1_6);
    assert.equal(body.units_to_fill, 1);
    assert.equal(body.include_optional_creator_fees, false);
    return json(cheap.fulfillment);
  } });
  assert.equal(requests.length, 2);
  assert.equal(result.candidates[0].priceWei, GROSS);
  assert.equal(result.source.boundedScan, true);
  assert.equal(result.source.maxPriceWei, null);
  assert.equal(JSON.stringify(result.source).includes('local-test-only'), false);
});

test('losslessly decodes OpenAPI integer wei fields before normalizing a basic order', async () => {
  const f = fixture({ price: GROSS + 1n, shape: 'basic' });
  const serialized = JSON.stringify(f.fulfillment)
    .replaceAll('"1560000000000000001"', '1560000000000000001')
    .replaceAll('"40000000000000000"', '40000000000000000');
  const result = await fetchBestListingOrders({ ...options, apiKey: 'local-test-only', fetchImpl: async (_url, init) =>
    init.method === 'GET' ? json({ listings: [f.listing], next: null }) : new Response(serialized) });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].priceWei, GROSS + 1n);
  assert.equal(result.candidates[0].advancedOrder.parameters.consideration[0].startAmount, '1560000000000000001');
});

test('discovery skips rejected listings, deduplicates and bounds pagination and fulfillment work', async () => {
  const f = fixture();
  const invalid = structuredClone(f.listing); invalid.protocol_address = seller;
  let reads = 0, posts = 0;
  const result = await fetchBestListingOrders({ ...options, apiKey: 'local-test-only', maxCandidates: 2, maxPages: 2,
    maxFulfillmentRequests: 1, fetchImpl: async (_url, init) => {
      if (init.method === 'POST') { posts++; return json(f.fulfillment); }
      reads++; return json({ listings: [invalid, f.listing, f.listing], next: 'bounded-cursor' });
    } });
  assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(result.candidates.length, 1); assert.equal(result.rejected.length, 1);
  assert.equal(result.source.morePagesAvailable, true);
  let pages = 0;
  const noMatches = await fetchBestListingOrders({ ...options, apiKey: 'local-test-only', maxPages: 2,
    fetchImpl: async () => json({ listings: [], next: `cursor-${++pages}` }) });
  assert.equal(pages, 2); assert.equal(noMatches.candidates.length, 0);
});

test('rejects missing credentials, redirects, oversized bodies and invalid JSON without leaking API keys', async () => {
  await assert.rejects(fetchBestListingOrders({ ...options, apiKey: '' }), /OPENSEA_API_KEY is required/);
  let calls = 0;
  await assert.rejects(fetchBestListingOrders({ ...options, apiKey: 'local-test-only', collectionSlug: '../evil',
    fetchImpl: async () => { calls++; } }), /Invalid collection slug/);
  assert.equal(calls, 0);
  for (const [response, pattern] of [
    [new Response('', { status: 302, headers: { location: 'https://evil.invalid' } }), /HTTP 302/],
    [new Response('private error', { status: 401 }), /HTTP 401/],
    [new Response('{}', { headers: { 'content-length': '2000001' } }), /too large/],
    [new Response('a'.repeat(2_000_001)), /too large/],
    [new Response('{not json'), /invalid or unsafe JSON/],
  ]) {
    await assert.rejects(fetchBestListingOrders({ ...options, apiKey: 'local-test-only', fetchImpl: async () => response }), pattern);
  }
  await assert.rejects(fetchBestListingOrders({ ...options, apiKey: 'local-test-only', fetchImpl: async () => {
    throw new Error('private headers x-api-key: local-test-only');
  } }), error => error.message === 'OpenSea request failed');
});

test('timeout and repeated cursors fail closed', async () => {
  await assert.rejects(fetchBestListingOrders({ ...options, apiKey: 'local-test-only', timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }) }), /timed out/);
  await assert.rejects(fetchBestListingOrders({ ...options, apiKey: 'local-test-only', maxPages: 3,
    fetchImpl: async () => json({ listings: [], next: 'same-cursor' }) }), /Repeated OpenSea cursor/);
});
