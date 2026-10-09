import { Interface, TypedDataEncoder, ZeroAddress, getAddress } from 'ethers';

// Wire schemas: https://api.opensea.io/api/v2/openapi.json
// https://docs.opensea.io/reference/get_best_listings_collection
// https://docs.opensea.io/reference/generate_listing_fulfillment_data_v2
// https://github.com/ProjectOpenSea/seaport-types/blob/main/src/lib/ConsiderationStructs.sol
export const OPENSEA_SIGNED_ZONE = '0x000056f7000000EcE9003ca63978907a00FFD100';
export const SEAPORT_1_6 = '0x0000000000000068F116a894984e2DB1123eB395';
const API_ORIGIN = 'https://api.opensea.io';
const MAX_BYTES = 2_000_000;
const UINT256_MAX = (1n << 256n) - 1n;
const offerFields = 'uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount';
const parametersType = `(address offerer,address zone,(${offerFields})[] offer,(${offerFields},address recipient)[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 totalOriginalConsiderationItems)`;
const basicType = '(address considerationToken,uint256 considerationIdentifier,uint256 considerationAmount,address offerer,address zone,address offerToken,uint256 offerIdentifier,uint256 offerAmount,uint8 basicOrderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 offererConduitKey,bytes32 fulfillerConduitKey,uint256 totalOriginalAdditionalRecipients,(uint256 amount,address recipient)[] additionalRecipients,bytes signature)';
const functions = new Interface([
  `function fulfillAdvancedOrder((${parametersType} parameters,uint120 numerator,uint120 denominator,bytes signature,bytes extraData) advancedOrder,(uint256 orderIndex,uint8 side,uint256 index,uint256 identifier,bytes32[] criteriaProof)[] criteriaResolvers,bytes32 fulfillerConduitKey,address recipient) payable returns(bool)`,
  `function fulfillOrder((${parametersType} parameters,bytes signature) order,bytes32 fulfillerConduitKey) payable returns(bool)`,
  `function fulfillBasicOrder(${basicType} parameters) payable returns(bool)`,
  `function fulfillBasicOrder_efficient_6GL6yc(${basicType} parameters) payable returns(bool)`,
]);
const supportedFunctions = new Map(functions.fragments.filter(f => f.type === 'function')
  .flatMap(f => [[f.name, f.name], [f.format('sighash'), f.name]]));
const fields = text => text.split(',').map(pair => {
  const [type, name] = pair.split(' ');
  return { name, type };
});
const orderTypes = {
  OrderComponents: fields('address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter'),
  OfferItem: fields(offerFields), ConsiderationItem: fields(`${offerFields},address recipient`),
};

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function uint(value, label, max = UINT256_MAX) {
  requireValue(typeof value === 'bigint' || typeof value === 'string' || Number.isSafeInteger(value), `Invalid ${label}`);
  const string = String(value);
  requireValue(/^(0|[1-9][0-9]*)$/.test(string) && string.length <= 78, `Invalid ${label}`);
  const result = BigInt(string);
  requireValue(result <= max, `Invalid ${label}`);
  return result;
}
function address(value, label) {
  requireValue(typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value), `Invalid ${label}`);
  return getAddress(value.toLowerCase());
}
function sameAddress(a, b) { return a.toLowerCase() === b.toLowerCase(); }
function fulfillmentRecipient(value) {
  // OpenAPI FulfillAdvancedOrder.recipient references Address, whose wire shape
  // is { value, typeAsString }. Older responses use the address string directly.
  if (typeof value === 'string') return address(value, 'NFT recipient');
  requireValue(value && typeof value === 'object' && !Array.isArray(value)
    && (value.typeAsString === undefined || value.typeAsString === 'address'), 'Invalid NFT recipient');
  return address(value.value, 'NFT recipient');
}
function hex(value, label, bytes) {
  requireValue(typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value), `Invalid ${label}`);
  requireValue(bytes === undefined ? value.length <= 32_770 : value.length === 2 + bytes * 2, `Invalid ${label}`);
  return value.toLowerCase();
}
function item(raw, consideration) {
  requireValue(raw && typeof raw === 'object', 'Invalid order item');
  const result = {
    itemType: Number(uint(raw.itemType, 'item type', 5n)), token: address(raw.token, 'item token'),
    identifierOrCriteria: uint(raw.identifierOrCriteria, 'item identifier').toString(),
    startAmount: uint(raw.startAmount, 'item amount').toString(), endAmount: uint(raw.endAmount, 'item end amount').toString(),
  };
  if (consideration) result.recipient = address(raw.recipient, 'consideration recipient');
  return result;
}
function parameters(raw) {
  requireValue(raw && typeof raw === 'object', 'Missing order parameters');
  requireValue(Array.isArray(raw.offer) && raw.offer.length === 1, 'Only single NFT orders are supported');
  requireValue(Array.isArray(raw.consideration) && raw.consideration.length > 0 && raw.consideration.length <= 16, 'Invalid consideration count');
  return {
    offerer: address(raw.offerer, 'offerer'), zone: address(raw.zone, 'zone'),
    offer: raw.offer.map(i => item(i, false)), consideration: raw.consideration.map(i => item(i, true)),
    orderType: Number(uint(raw.orderType, 'order type', 4n)),
    startTime: uint(raw.startTime, 'start time').toString(), endTime: uint(raw.endTime, 'end time').toString(),
    zoneHash: hex(raw.zoneHash, 'zone hash', 32), salt: uint(raw.salt, 'salt').toString(),
    conduitKey: hex(raw.conduitKey, 'conduit key', 32),
    totalOriginalConsiderationItems: Number(uint(raw.totalOriginalConsiderationItems, 'original consideration count', 16n)),
  };
}

/** Seaport getOrderHash is the EIP-712 OrderComponents struct hash, without a domain. */
export function computeSeaportOrderHash(raw, counter = raw.counter) {
  const p = parameters(raw);
  const originalCount = p.totalOriginalConsiderationItems;
  requireValue(originalCount > 0 && originalCount <= p.consideration.length, 'Invalid original consideration count');
  return TypedDataEncoder.hashStruct('OrderComponents', orderTypes, {
    ...p, consideration: p.consideration.slice(0, originalCount), counter: uint(counter, 'order counter'),
  });
}

function validateOrder(p, options) {
  const offer = p.offer[0];
  requireValue(offer.itemType === 2 && sameAddress(offer.token, options.collectionAddress)
    && offer.startAmount === '1' && offer.endAmount === '1', 'Order is not one NFT from the configured collection');
  requireValue(p.orderType === 0 || p.orderType === 2, 'Only full open or full restricted orders are supported');
  requireValue(sameAddress(p.zone, ZeroAddress) || sameAddress(p.zone, options.allowedZoneAddress), 'Unsupported restricted zone');
  requireValue(p.orderType !== 2 || sameAddress(p.zone, options.allowedZoneAddress), 'Unsupported restricted zone');
  requireValue(!sameAddress(p.offerer, ZeroAddress) && !sameAddress(p.offerer, options.treasuryAddress)
    && !sameAddress(p.offerer, options.marketAddress), 'Invalid seller');
  requireValue(p.totalOriginalConsiderationItems === p.consideration.length, 'Unsigned consideration tips are not supported');
  requireValue(BigInt(p.startTime) <= options.nowSeconds && BigInt(p.endTime) > options.nowSeconds, 'Order is not active');
  let total = 0n;
  for (const c of p.consideration) {
    requireValue(c.itemType === 0 && sameAddress(c.token, ZeroAddress) && c.identifierOrCriteria === '0', 'Only native ETH consideration is supported');
    requireValue(c.startAmount === c.endAmount && BigInt(c.startAmount) > 0n, 'Only fixed positive prices are supported');
    requireValue(!sameAddress(c.recipient, ZeroAddress) && !sameAddress(c.recipient, options.treasuryAddress)
      && !sameAddress(c.recipient, options.marketAddress), 'Invalid payment recipient');
    total += BigInt(c.startAmount);
  }
  requireValue(total <= options.maxPriceWei, 'Listing exceeds the purchase cap including all fees');
  return { tokenId: BigInt(offer.identifierOrCriteria), priceWei: total };
}

function settings(options) {
  return {
    collectionAddress: address(options.collectionAddress, 'collection address'),
    marketAddress: address(options.marketAddress, 'market address'),
    treasuryAddress: address(options.treasuryAddress, 'treasury address'),
    seaportAddress: address(options.seaportAddress ?? SEAPORT_1_6, 'Seaport address'),
    allowedZoneAddress: address(options.allowedZoneAddress ?? OPENSEA_SIGNED_ZONE, 'allowed zone address'),
    maxPriceWei: options.maxPriceWei === undefined ? UINT256_MAX : uint(options.maxPriceWei, 'available purchase budget'),
    nowSeconds: uint(options.nowSeconds ?? Math.floor(Date.now() / 1000), 'current time'),
  };
}

function validateListing(listing, options) {
  requireValue(listing?.chain === 'ethereum' && listing.status === 'ACTIVE' && !listing.svm_order, 'Listing is not active on Ethereum');
  requireValue(uint(listing.remaining_quantity, 'remaining quantity') === 1n, 'Listing quantity must be one');
  requireValue(sameAddress(address(listing.protocol_address, 'listing protocol'), options.seaportAddress), 'Unexpected listing protocol');
  requireValue(listing.price?.current?.currency === 'ETH' && uint(listing.price.current.decimals, 'price decimals') === 18n, 'Listing currency must be ETH');
  const p = parameters(listing.protocol_data?.parameters);
  const result = validateOrder(p, options);
  const counter = uint(listing.protocol_data.parameters.counter, 'order counter');
  const orderHash = hex(listing.order_hash, 'order hash', 32);
  requireValue(computeSeaportOrderHash(p, counter) === orderHash, 'Listing order hash mismatch');
  requireValue(result.priceWei === uint(listing.price.current.value, 'listing price'), 'Displayed price differs from signed consideration');
  if (listing.asset != null) {
    requireValue(sameAddress(address(listing.asset.contract, 'asset contract'), options.collectionAddress)
      && uint(listing.asset.identifier, 'asset identifier') === result.tokenId, 'Listing asset mismatch');
  }
  return { ...result, counter, orderHash, parameters: p };
}

function basicToAdvanced(b) {
  requireValue(b && typeof b === 'object', 'Missing basic order');
  const route = uint(b.basicOrderType, 'basic order route', 23n);
  requireValue(route === 0n || route === 2n, 'Only full ETH to ERC721 basic orders are supported');
  requireValue(Array.isArray(b.additionalRecipients) && b.additionalRecipients.length <= 15, 'Invalid basic recipients');
  requireValue(uint(b.totalOriginalAdditionalRecipients, 'original additional recipients') === BigInt(b.additionalRecipients.length), 'Unsigned consideration tips are not supported');
  // Read only to validate the API shape; never copy this buyer-side hint. The
  // adapter buy() hardcodes bytes32(0), and AdvancedOrder has no such field.
  hex(b.fulfillerConduitKey, 'fulfiller conduit', 32);
  const ethItem = (amount, recipient) => ({ itemType: 0, token: b.considerationToken,
    identifierOrCriteria: b.considerationIdentifier, startAmount: amount, endAmount: amount, recipient });
  return {
    parameters: parameters({
      offerer: b.offerer, zone: b.zone,
      offer: [{ itemType: 2, token: b.offerToken, identifierOrCriteria: b.offerIdentifier, startAmount: b.offerAmount, endAmount: b.offerAmount }],
      consideration: [ethItem(b.considerationAmount, b.offerer), ...b.additionalRecipients.map(r => ethItem(r.amount, r.recipient))],
      orderType: route, startTime: b.startTime, endTime: b.endTime, zoneHash: b.zoneHash,
      salt: b.salt, conduitKey: b.offererConduitKey, totalOriginalConsiderationItems: b.additionalRecipients.length + 1,
    }),
    numerator: 1, denominator: 1, signature: b.signature, extraData: '0x',
  };
}

/** Never returns API-supplied calldata or a transaction target. Only the typed order may be registered. */
export function normalizeOpenSeaFulfillment({ listing, fulfillment, ...rawOptions }) {
  const options = settings(rawOptions);
  const candidate = validateListing(listing, options);
  requireValue(fulfillment?.protocol === 'seaport', 'Unsupported fulfillment protocol');
  const data = fulfillment.fulfillment_data;
  requireValue(data && Array.isArray(data.orders) && data.orders.length === 1, 'Only one fulfillment order is supported');
  const transaction = data.transaction;
  requireValue(transaction && uint(transaction.chain, 'transaction chain') === 1n, 'Unexpected fulfillment chain');
  requireValue(sameAddress(address(transaction.to, 'transaction target'), options.seaportAddress), 'Unexpected fulfillment target');
  requireValue(uint(transaction.value, 'transaction value') === candidate.priceWei, 'Fulfillment value differs from the signed price');
  const name = supportedFunctions.get(transaction.function);
  requireValue(name, 'Unsupported fulfillment function');
  const input = transaction.input_data;
  requireValue(input && typeof input === 'object', 'Missing fulfillment input');
  let order;
  if (name === 'fulfillAdvancedOrder') {
    requireValue(Array.isArray(input.criteriaResolvers) && input.criteriaResolvers.length === 0, 'Criteria orders are not supported');
    // SeaportListingMarket.buy always supplies bytes32(0), independently of API data.
    hex(input.fulfillerConduitKey, 'fulfiller conduit', 32);
    requireValue(sameAddress(fulfillmentRecipient(input.recipient), options.treasuryAddress), 'Unexpected NFT recipient');
    order = input.advancedOrder;
  } else if (name === 'fulfillOrder') {
    hex(input.fulfillerConduitKey, 'fulfiller conduit', 32);
    order = { ...input.order, numerator: 1, denominator: 1, extraData: '0x' };
  } else {
    order = basicToAdvanced(input.parameters);
  }
  requireValue(order && uint(order.numerator, 'fill numerator') === 1n && uint(order.denominator, 'fill denominator') === 1n, 'Partial fills are not supported');
  const advancedOrder = {
    parameters: parameters(order.parameters), numerator: 1, denominator: 1,
    signature: hex(order.signature, 'order signature'), extraData: hex(order.extraData, 'zone extra data'),
  };
  // Only these five AdvancedOrder fields are returned. Neither transaction target,
  // calldata nor the API fulfiller conduit may reach the keeper's transaction.
  requireValue(advancedOrder.signature.length <= 2 + 4096 * 2, 'Order signature is too large');
  requireValue(advancedOrder.extraData.length <= 2 + 8192 * 2, 'Zone extra data is too large');
  const final = validateOrder(advancedOrder.parameters, options);
  requireValue(final.priceWei === candidate.priceWei && final.tokenId === candidate.tokenId, 'Fulfillment order differs from listing');
  requireValue(computeSeaportOrderHash(advancedOrder.parameters, candidate.counter) === candidate.orderHash, 'Fulfillment order hash mismatch');
  const suppliedOrder = data.orders[0];
  requireValue(computeSeaportOrderHash(suppliedOrder.parameters) === candidate.orderHash, 'Fulfillment metadata order hash mismatch');
  requireValue(hex(suppliedOrder.signature, 'metadata signature') === advancedOrder.signature, 'Fulfillment signature mismatch');
  requireValue(advancedOrder.parameters.orderType !== 2 || advancedOrder.extraData !== '0x', 'Restricted orders require fresh zone authorization');
  return {
    tokenId: candidate.tokenId, priceWei: candidate.priceWei, counter: candidate.counter,
    orderHash: candidate.orderHash, seller: advancedOrder.parameters.offerer, advancedOrder,
    source: { marketplace: 'OpenSea', collection: rawOptions.collectionSlug ?? null,
      fulfillmentFunction: name, listingUrl: `https://opensea.io/item/ethereum/${options.collectionAddress}/${candidate.tokenId}` },
  };
}

function parseJson(text) {
  // The OpenAPI basic-order schema permits integer (rather than string) wei values.
  // Preserve their original decimal tokens before JavaScript rounding can alter an order.
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
    requireValue(context?.source && /^(0|[1-9][0-9]*)$/.test(context.source), 'Unsafe JSON number');
    return context.source;
  });
}

async function requestJson(path, { apiKey, fetchImpl, body, timeoutMs }) {
  const url = new URL(path, API_ORIGIN);
  requireValue(url.origin === API_ORIGIN && url.pathname.startsWith('/api/v2/'), 'Unexpected OpenSea endpoint');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
      headers: { accept: 'application/json', 'x-api-key': apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    requireValue(response.ok, `OpenSea API returned HTTP ${Number(response.status) || 0}`);
    requireValue(!response.redirected && (!response.url || new URL(response.url).origin === API_ORIGIN), 'Unexpected OpenSea response origin');
    const contentLength = response.headers?.get('content-length');
    requireValue(contentLength == null || (Number.isSafeInteger(Number(contentLength)) && Number(contentLength) <= MAX_BYTES), 'OpenSea response is too large');
    requireValue(response.body?.getReader, 'OpenSea response has no readable body');
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        requireValue(size <= MAX_BYTES, 'OpenSea response is too large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    try { return parseJson(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('OpenSea returned invalid or unsafe JSON'); }
  } catch (error) {
    // Do not expose request headers, API keys, remote bodies or attacker-controlled errors.
    if (/^OpenSea (API returned HTTP [0-9]+|response (is too large|has no readable body)|returned invalid or unsafe JSON)$/.test(error.message)
      || error.message === 'Unexpected OpenSea response origin') throw error;
    throw new Error(controller.signal.aborted ? 'OpenSea request timed out' : 'OpenSea request failed');
  } finally { clearTimeout(timer); }
}

/**
 * Discover a bounded price-ordered window and fetch typed, buyer-bound fulfillment data.
 * Read-only: POST here builds an unsigned payload; it neither buys nor lists an NFT.
 * The keeper must simulate registration/purchase and recheck live state before broadcasting.
 */
export async function fetchBestListingOrders({
  apiKey = process.env.OPENSEA_API_KEY, collectionSlug = 'contractclaus', fetchImpl = globalThis.fetch,
  maxPages = 2, pageSize = 20, maxCandidates = 1, maxFulfillmentRequests = 8, timeoutMs = 15_000, ...rawOptions
}) {
  requireValue(typeof apiKey === 'string' && apiKey.length > 0 && !/[\r\n]/.test(apiKey), 'OPENSEA_API_KEY is required');
  requireValue(typeof collectionSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,199}$/.test(collectionSlug), 'Invalid collection slug');
  requireValue(typeof fetchImpl === 'function', 'A fetch implementation is required');
  for (const [value, max, label] of [[maxPages, 3, 'pages'], [pageSize, 50, 'page size'], [maxCandidates, 10, 'candidates'], [maxFulfillmentRequests, 20, 'fulfillment requests'], [timeoutMs, 30_000, 'timeout']]) {
    requireValue(Number.isInteger(value) && value > 0 && value <= max, `Invalid maximum ${label}`);
  }
  const options = settings(rawOptions);
  const transport = { apiKey, fetchImpl, timeoutMs };
  const candidates = [], rejected = [], seen = new Set(), cursors = new Set();
  let next, pages = 0, fulfillmentRequests = 0;
  do {
    const query = new URLSearchParams({ limit: String(pageSize), include_private_listings: 'false' });
    if (next) query.set('next', next);
    const page = await requestJson(`/api/v2/listings/collection/${collectionSlug}/best?${query}`, transport);
    pages++;
    requireValue(Array.isArray(page.listings) && page.listings.length <= pageSize, 'Invalid OpenSea listing page');
    const validated = [];
    for (const listing of page.listings) {
      try {
        const candidate = validateListing(listing, options);
        if (!seen.has(candidate.orderHash)) { seen.add(candidate.orderHash); validated.push({ listing, candidate }); }
      } catch (error) {
        rejected.push({ orderHash: /^0x[0-9a-fA-F]{64}$/.test(listing?.order_hash) ? listing.order_hash.toLowerCase() : null, reason: error.message });
      }
    }
    validated.sort((a, b) => a.candidate.priceWei < b.candidate.priceWei ? -1 : a.candidate.priceWei > b.candidate.priceWei ? 1 : 0);
    for (const { listing, candidate } of validated) {
      if (candidates.length >= maxCandidates || fulfillmentRequests >= maxFulfillmentRequests) break;
      fulfillmentRequests++;
      try {
        const fulfillment = await requestJson('/api/v2/listings/fulfillment_data', { ...transport, body: {
          listing: { hash: candidate.orderHash, chain: 'ethereum', protocol_address: options.seaportAddress },
          fulfiller: { address: options.marketAddress }, recipient: options.treasuryAddress,
          units_to_fill: 1, include_optional_creator_fees: false,
        } });
        candidates.push(normalizeOpenSeaFulfillment({ listing, fulfillment, collectionSlug, ...options }));
      } catch (error) { rejected.push({ orderHash: candidate.orderHash, reason: error.message }); }
    }
    requireValue(page.next == null || (typeof page.next === 'string' && page.next.length <= 2048), 'Invalid OpenSea cursor');
    next = page.next || null;
    if (next && cursors.has(next)) throw new Error('Repeated OpenSea cursor');
    if (next) cursors.add(next);
  } while (next && pages < maxPages && candidates.length < maxCandidates && fulfillmentRequests < maxFulfillmentRequests);
  return { candidates, rejected, source: {
    marketplace: 'OpenSea', collectionSlug, chain: 'ethereum', pages, fulfillmentRequests,
    boundedScan: true, morePagesAvailable: Boolean(next), maxPriceWei: rawOptions.maxPriceWei === undefined ? null : options.maxPriceWei.toString(),
  } };
}
