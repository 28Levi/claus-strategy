#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, Wallet, keccak256 } from 'ethers';
import { fetchBestListingOrders } from './opensea.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function abi(name) { return JSON.parse(await fs.readFile(path.join(ROOT, 'artifacts', `${name}.json`), 'utf8')).abi; }

export async function verifyDeployment(provider, treasury, manifest) {
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(manifest.chainId)) throw new Error('Wrong RPC chain; refusing to operate.');
  const hookAddress = await treasury.hook();
  const addresses = {
    treasury: treasury.target, hook: hookAddress, token: await treasury.token(),
    collection: await treasury.collection(), market: await treasury.market(), initializer: await treasury.initializer(),
  };
  for (const [role, address] of Object.entries(addresses)) {
    const expected = manifest.contracts?.[role];
    if (!expected?.runtimeCodeHash || expected.address?.toLowerCase() !== address.toLowerCase()) {
      throw new Error(`Missing or mismatched verified ${role} binding.`);
    }
    const code = await provider.getCode(address);
    if (code === '0x' || keccak256(code) !== expected.runtimeCodeHash) throw new Error(`Runtime mismatch for ${role}.`);
  }
  const hook = new Contract(hookAddress, ['function poolManager() view returns (address)'], provider);
  const manager = await hook.poolManager();
  const expectedManager = manifest.contracts?.poolManager;
  if (expectedManager?.address?.toLowerCase() !== manager.toLowerCase()
      || keccak256(await provider.getCode(manager)) !== expectedManager?.runtimeCodeHash) {
    throw new Error('Missing or mismatched verified PoolManager binding.');
  }
  // Identify the adapter from its binding, not solely from user-editable metadata.
  const market = new Contract(addresses.market, [
    'function seaport() view returns (address)', 'function conduitController() view returns (address)',
    'function allowedZone() view returns (address)', 'function purchaseBot() view returns (address)',
  ], provider);
  let seaport;
  try { seaport = await market.seaport(); } catch {}
  if (seaport) {
    if (manifest.acquisition?.venue !== 'opensea') throw new Error('OpenSea acquisition manifest is required.');
    for (const [role, address] of Object.entries({seaport, conduitController:await market.conduitController(), allowedZone:await market.allowedZone()})) {
      const expected = manifest.contracts?.[role];
      const code = await provider.getCode(address);
      if (expected?.address?.toLowerCase() !== address.toLowerCase() || code === '0x' || expected.runtimeCodeHash !== keccak256(code)) {
        throw new Error(`Missing or mismatched verified ${role} binding.`);
      }
    }
    if (manifest.acquisition.purchaseBotAddress?.toLowerCase() !== (await market.purchaseBot()).toLowerCase()) {
      throw new Error('Missing or mismatched purchase bot binding.');
    }
    if (!manifest.acquisition.collectionSlug) throw new Error('OpenSea collection slug is required.');
  } else if (manifest.acquisition?.venue === 'opensea') throw new Error('Configured market is not the OpenSea adapter.');
}

export async function inspectActions(treasury, now) {
  const actions = [];
  const skipped = [];
  const q = await treasury.cheapestListing();
  if (q.found && BigInt(now) >= await treasury.nextPurchaseAt()) {
    try {
      await treasury.purchaseCheapest.staticCall(q.tokenId, q.revision);
      actions.push({ method: 'purchaseCheapest', args: [q.tokenId, q.revision], nftPriceWei: q.price.toString() });
    } catch { skipped.push('Acquisition currently fails its on-chain budget, inventory or listing checks.'); }
  }
  if (await treasury.buybackBalance() > 0n && BigInt(now) >= await treasury.nextBuybackAt()) {
    try {
      await treasury.executeBuyback.staticCall();
      actions.push({ method: 'executeBuyback', args: [] });
    } catch { skipped.push('Buyback currently fails its on-chain history, liquidity or minimum-output checks.'); }
  }
  return { actions, skipped };
}

export function gasBudget(gas, maxFeePerGas, ceilingWei) {
  // Conservative 20% gas headroom, rounded up; never relax the monetary ceiling.
  const gasLimit = (gas * 120n + 99n) / 100n;
  if (gasLimit * maxFeePerGas > ceilingWei) throw new Error('Estimated worst-case gas cost exceeds operator limit.');
  return gasLimit;
}

export async function inspectOpenSeaActions(treasury, market, manifest, now, fetchOrders = fetchBestListingOrders) {
  const actions = [], skipped = [];
  const available = await treasury.acquisitionBalance();
  if (available === 0n || BigInt(now) < await treasury.nextPurchaseAt() || await treasury.inventoryCount() >= await treasury.maxInventory()) {
    return {actions, skipped:['Waiting for acquisition ETH, purchase interval, or free inventory capacity.']};
  }
  const cap = await treasury.maxPurchasePrice();
  const book = await fetchOrders({
    collectionSlug:manifest.acquisition.collectionSlug, collectionAddress:await treasury.collection(),
    marketAddress:market.target, treasuryAddress:treasury.target, seaportAddress:await market.seaport(),
    allowedZoneAddress:await market.allowedZone(), nowSeconds:now, maxCandidates:4,
    // This is current affordability, not a fixed launch price ceiling.
    maxPriceWei:cap > 0n && cap < available ? cap : available,
  });
  const bot = await market.purchaseBot();
  for (const candidate of book.candidates) {
    if (candidate.priceWei > available) continue;
    try {
      await market.registerAndPurchase.staticCall(candidate.advancedOrder, treasury.target, {from:bot});
      actions.push({method:'registerAndPurchase',args:[candidate.advancedOrder,treasury.target],nftPriceWei:candidate.priceWei.toString(),orderHash:candidate.orderHash});
      break;
    } catch { skipped.push(`Order ${candidate.orderHash} is no longer executable under the treasury and Seaport checks.`); }
  }
  if (actions.length === 0) skipped.push('No supported, executable OpenSea listing is affordable with acquisition funds.');
  return {actions, skipped, source:book.source, rejected:book.rejected};
}

async function main() {
  const args = process.argv.slice(2);
  const at = args.indexOf('--manifest');
  if (at < 0 || !args[at + 1]) throw new Error('Usage: node scripts/keeper.mjs --manifest deployment.json [--execute]');
  const manifest = JSON.parse(await fs.readFile(path.resolve(args[at + 1]), 'utf8'));
  const rpc = process.env.CLAUS_RPC_URL;
  if (!rpc) throw new Error('Set CLAUS_RPC_URL in your environment.');
  const provider = new JsonRpcProvider(rpc);
  try {
    let treasury = new Contract(manifest.contracts?.treasury?.address, await abi('StrategyTreasury'), provider);
    await verifyDeployment(provider, treasury, manifest);
    let hook = new Contract(await treasury.hook(), await abi('StrategyV4Hook'), provider);
    const openSea = manifest.acquisition?.venue === 'opensea';
    let market = openSea ? new Contract(await treasury.market(), await abi('SeaportListingMarket'), provider) : null;
    async function inspect(now) {
      const base = await inspectActions(treasury, now);
      if (!market) return base;
      const acquisition = await inspectOpenSeaActions(treasury,market,manifest,now);
      return {actions:[...acquisition.actions,...base.actions.filter(a => a.method !== 'purchaseCheapest')],
        skipped:[...acquisition.skipped,...base.skipped],source:acquisition.source,rejected:acquisition.rejected};
    }
    const pendingFeeWei = await hook.pendingFees();
    const block = await provider.getBlock('latest');
    const inspection = await inspect(block.timestamp);
    console.log(JSON.stringify({ mode: args.includes('--execute') ? 'execute' : 'read-only', pendingFeeWei, ...inspection }, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
    if (!args.includes('--execute')) return;
    if (market && !process.env.OPENSEA_API_KEY) throw new Error('Execution requires OPENSEA_API_KEY before any transaction is sent.');
    if (!process.env.CLAUS_KEEPER_PRIVATE_KEY) throw new Error('Execution requires CLAUS_KEEPER_PRIVATE_KEY in the environment. Never put it in the manifest.');
    const cap = BigInt(manifest.operator?.maxGasCostWei ?? '0');
    if (cap <= 0n) throw new Error('Set a positive operator.maxGasCostWei before execution.');
    const signer = new Wallet(process.env.CLAUS_KEEPER_PRIVATE_KEY, provider);
    if (market && signer.address.toLowerCase() !== (await market.purchaseBot()).toLowerCase()) throw new Error('Signer is not the immutable purchase bot.');
    treasury = treasury.connect(signer);
    hook = hook.connect(signer);
    if (market) market = market.connect(signer);
    async function sendAction(contract, action) {
      const fn = contract.getFunction(action.method);
      const estimate = await fn.estimateGas(...action.args);
      const fees = await provider.getFeeData();
      const maxFeePerGas = fees.maxFeePerGas ?? fees.gasPrice;
      if (!maxFeePerGas) throw new Error('No reliable gas-price estimate.');
      const gasLimit = gasBudget(estimate, maxFeePerGas, cap);
      const feeOptions = fees.maxFeePerGas ? { maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n } : { gasPrice: maxFeePerGas };
      const transaction = await fn(...action.args, { gasLimit, ...feeOptions });
      const receipt = await transaction.wait();
      if (receipt.status !== 1) throw new Error(`Transaction failed: ${transaction.hash}`);
      console.log(`${action.method}: ${transaction.hash}`);
    }
    // Claims are redeemed after input settlement, then new ETH can fund a purchase.
    // One pass, at most one fee flush, one acquisition and one buyback.
    if (pendingFeeWei > 0n) await sendAction(hook, { method: 'flushFees', args: [] });
    const currentBlock = await provider.getBlock('latest');
    const current = await inspect(currentBlock.timestamp);
    for (const action of current.actions) await sendAction(action.method === 'registerAndPurchase' ? market : treasury, action);
  } finally { provider.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.shortMessage ?? error.message); process.exitCode = 1; });
}
