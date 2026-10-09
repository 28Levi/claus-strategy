#!/usr/bin/env node
// Self-contained, ephemeral LOCAL EVM demonstration. No external wallet/RPC or funds.
import fs from 'node:fs/promises';
import { v4Fixture, tx, E } from '../test/helper.mjs';
import { makeOrder } from '../test/seaport-helper.mjs';

const f = await v4Fixture(undefined, {
  mode:'token-only', market:'opensea', slippageBps:100,
  config:{maxPurchasePrice:0,maxSpendPerEpoch:0,minPurchaseInterval:3600,maxInventory:3,maxBuybackAmount:E('0.01'),minBuybackInterval:300},
});
try {
  await f.swap(f.buyer, true, E('100'));
  await tx(f.hook.connect(f.attacker).flushFees());
  const fee = await f.treasury.totalFeesReceived();
  const listing = await makeOrder(f,{restricted:true});
  const purchase = await tx(f.market.registerAndPurchase(listing.order,f.treasury.target));
  const ask = (await f.treasury.positions(1)).ask;
  await tx(f.treasury.connect(f.buyer).buyNFT(1, f.addresses[2], { value: ask }));
  await f.time(1801);
  const before = await f.token.totalSupply();
  await tx(f.treasury.connect(f.attacker).executeBuyback());
  const report = {
    environment: 'ephemeral Hardhat Cancun EVM', mainnetDeployment: false,
    launchMode: 'token-only', launchSeedWei: f.seed, poolLpFee: 0,
    realUniswapV4PoolManager: true, marketplace: 'Real Seaport 1.6; mock NFT and restricted zone; synthetic signed order, no live OpenSea API',
    strategyFeeBps: 200, buyWei: E('100'), treasuryFeesWei: fee,
    purchasePriceCapWei:0n, dailySpendCapWei:0n, pricingPolicy:'trusted-bot', buybackSlippageBps:100,
    nftCostWei: E('1.6'), nftResaleWei: ask, acquisitionGasUsed: purchase.gasUsed,
    burnedTokenWei: before - await f.token.totalSupply(), buybackReserveWei: await f.treasury.buybackBalance(),
    initialLiquidityLocked: await f.initializer.lockedLiquidity(),
    treasuryETHWei: await f.balance(f.treasury.target),
    acquisitionReserveWei: await f.treasury.acquisitionBalance(),
  };
  const json = JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2);
  await fs.mkdir('output', { recursive: true });
  await fs.writeFile('output/demo-report.json', json + '\n');
  console.log(json);
} finally { await f.close(); }
