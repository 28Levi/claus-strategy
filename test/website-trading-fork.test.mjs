import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { BrowserProvider, Contract, JsonRpcProvider, keccak256, formatEther } from 'ethers';
import hre from 'hardhat';
import { artifacts, deploy, deployHook, E, treasuryConfig, tx } from './helper.mjs';
import { DEPENDENCIES, PERMIT2_ABI, encodeTrade, executeTrade, quoteTrade, verifyTradingDeployment } from '../website/dist/trading.mjs';
import { makePublicConfig, verifyPublicConfig } from '../scripts/export-website-config.mjs';

const RPC = process.env.CLAUS_TRADING_FORK_RPC;

test('website quotes and executes real Universal Router buys/sells with the 2% strategy hook on an isolated Ethereum fork', {
  skip: RPC ? false : 'Set CLAUS_TRADING_FORK_RPC to an Ethereum RPC for the optional canonical-router integration.',
  timeout: 240_000,
}, async t => {
  const source = new JsonRpcProvider(RPC, 1, { staticNetwork: true });
  const pin = await source.getBlock('latest');
  source.destroy();
  // Mainnet domain is intentional so the production website's chain guard can
  // run unchanged. The independent Hardhat checks below prohibit remote writes.
  const connection = await hre.network.create({ network: 'hardhatMainnet', override: {
    chainId: 1, forking: { url: RPC, blockNumber: pin.number },
  } });
  assert.equal(connection.networkConfig.type, 'edr-simulated');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  assert.match(await provider.send('web3_clientVersion', []), /Hardhat/i);
  assert.equal((await provider.getBlock(pin.number)).hash, pin.hash);
  const admin = await provider.getSigner(0), owner = await admin.getAddress();
  const manager = new Contract(DEPENDENCIES.poolManager.address, artifacts.PoolManager.abi, admin);
  const initializer = await deploy('StrategyTokenOnlyInitializer', admin, [owner]);
  const token = await deploy('StrategyToken', admin, ['Website strategy test', 'WTEST', E('1000000000'), initializer.target]);
  const siteBase=JSON.parse(await readFile(new URL('../website/dist/config.json',import.meta.url),'utf8'));
  const openSeaRelease=JSON.parse(await readFile(new URL('../config/opensea.ethereum-release.json',import.meta.url),'utf8'));
  const market = await deploy('SeaportListingMarket', admin, [siteBase.collection,openSeaRelease.seaport,openSeaRelease.conduitController,openSeaRelease.allowedZone,owner]);
  const treasury = await deploy('StrategyTreasury', admin, [treasuryConfig({ token: token.target, nft: siteBase.collection, market: market.target, initializer: initializer.target,maxPurchasePrice:0,maxSpendPerEpoch:0 })]);
  const hook = await deployHook(admin, [manager.target, token.target, treasury.target, initializer.target, 200, 1800, 500]);
  await tx(initializer.initialize(treasury.target, hook.target, await initializer.initialSqrtPriceX96(), { value: 2n }));
  const config = { status: 'live', chainId: 1, contracts: {}, trading: { dependencies: {} } };
  for (const [name, contract] of Object.entries({ token, treasury, hook, initializer, poolManager: manager })) {
    config.contracts[name] = { address: contract.target, runtimeCodeHash: keccak256(await provider.getCode(contract.target)) };
  }
  for (const name of ['router', 'quoter', 'permit2']) config.trading.dependencies[name] = { ...DEPENDENCIES[name] };
  await verifyTradingDeployment(config, provider);
  const manifest={chainId:1,contracts:{...config.contracts},acquisition:{venue:'opensea',collectionSlug:'contractclaus',pricingPolicy:'trusted-bot',purchaseBotAddress:owner}};
  const otherAddresses={market:market.target,collection:siteBase.collection,seaport:openSeaRelease.seaport,conduitController:openSeaRelease.conduitController,allowedZone:openSeaRelease.allowedZone};
  for(const [role,address]of Object.entries(otherAddresses))manifest.contracts[role]={address,runtimeCodeHash:keccak256(await provider.getCode(address))};
  const publicConfig=makePublicConfig(siteBase,manifest,{dependencies:DEPENDENCIES});
  const exportEvidence=await verifyPublicConfig(publicConfig,manifest,provider);
  assert.ok(exportEvidence.verifiedBlock>pin.number,'Website export must verify the complete deployed graph');
  const sentHashes = [];
  const ethereum = { request: async ({ method, params }) => {
    const result = await connection.provider.request({
      method: method === 'eth_requestAccounts' ? 'eth_accounts' : method, params: params ?? [],
    });
    if (method === 'eth_sendTransaction') sentHashes.push(result);
    return result;
  } };
  const statuses = [];
  const buy = await quoteTrade({ config, provider, direction: 'buy', amount: '0.01' });
  assert.ok(BigInt(buy.amountOutWei) > 0n);
  assert.equal(await hook.pendingFees(), 0n, 'Read-only quotes must not accrue real fees');
  const bought = await executeTrade({ config, ethereum, quote: buy, onStatus: s => statuses.push(s) });
  assert.equal(bought.receipt.status, 1);
  assert.equal(await token.balanceOf(owner), BigInt(buy.amountOutWei));
  assert.equal(await hook.pendingFees(), E('0.0002'));
  assert.equal(await token.balanceOf(DEPENDENCIES.router.address), 0n);
  const saleAmount = (await token.balanceOf(owner)) / 2n;
  const sell = await quoteTrade({ config, provider, direction: 'sell', amount: formatEther(saleAmount) });
  const feesBefore = await hook.pendingFees();
  const ethBefore = await provider.getBalance(owner), firstSaleTransaction = sentHashes.length;
  const sold = await executeTrade({ config, ethereum, quote: sell, onStatus: s => statuses.push(s) });
  assert.equal(sold.receipt.status, 1);
  assert.equal(await token.balanceOf(owner), BigInt(buy.amountOutWei) - saleAmount);
  assert.equal(await token.allowance(owner, DEPENDENCIES.permit2.address), 0n, 'Exact ERC20 allowance consumed');
  const saleReceipts = await Promise.all(sentHashes.slice(firstSaleTransaction).map(hash => provider.getTransactionReceipt(hash)));
  const gasCost = saleReceipts.reduce((sum, receipt) => sum + receipt.fee, 0n);
  assert.equal(await provider.getBalance(owner) - ethBefore + gasCost, BigInt(sell.amountOutWei), 'Actual net ETH payout matches the fee-inclusive quote');
  const permit2 = new Contract(DEPENDENCIES.permit2.address, PERMIT2_ABI, provider);
  assert.equal((await permit2.allowance(owner, token.target, DEPENDENCIES.router.address)).amount, 0n, 'Exact Permit2 allowance consumed');
  const sellFee = (await hook.pendingFees()) - feesBefore;
  assert.ok(sellFee > 0n);
  const events = sold.receipt.logs.flatMap(log => { try { return [hook.interface.parseLog(log)]; } catch { return []; } }).filter(Boolean);
  assert.equal(events.find(event => event.name === 'TradingFeeCollected').args.amount, sellFee);
  assert.equal(sellFee, (BigInt(sell.amountOutWei) + sellFee) * 200n / 10_000n);
  await tx(hook.flushFees());
  assert.equal(await treasury.acquisitionBalance(), E('0.0002') + sellFee);
  assert.equal(await hook.pendingFees(), 0n);
  const impossible = { ...buy, amountOutWei: (BigInt(buy.amountOutWei) * 100n).toString(), minOutWei: (BigInt(buy.amountOutWei) * 99n).toString() };
  await assert.rejects(provider.call({ ...encodeTrade(config, impossible), from: owner }));
  const expired = { ...buy, deadline: (await provider.getBlock('latest')).timestamp - 1 };
  await assert.rejects(executeTrade({ config, ethereum, quote: expired }), /expired/);
  const badConfig = structuredClone(config); badConfig.contracts.token.runtimeCodeHash = `0x${'00'.repeat(32)}`;
  await assert.rejects(verifyTradingDeployment(badConfig, provider), /code does not match/);
  const proof = { checkedAt: new Date().toISOString(), scope: 'isolated Hardhat fork of canonical Ethereum UniversalRouter, V4Quoter, Permit2 and PoolManager',
    sourceBlock: pin.number, sourceBlockHash: pin.hash, dependencies: DEPENDENCIES, tokenOnlyLaunch: true,
    actualBuyOutputEqualsQuote: true, actualSellOutputEqualsQuote: true, actualSellExactInput: true, buyFeeWei: E('0.0002').toString(), sellFeeWei: sellFee.toString(),
    quoteIncludesBuyAndSellFees: true, exactAllowancesConsumed: true, badCodeRejected: true, staleQuoteRejected: true,
    impossibleMinimumRejected: true, treasuryFeesFlushed: true, websiteExecuteFunctionUsed: true, websiteExportValidationPassed:true, mainnetWrites: false };
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/website-trading-fork-proof.json', import.meta.url), JSON.stringify(proof, null, 2) + '\n');
  t.diagnostic(`Canonical router buy/sell passed at Ethereum block ${pin.number}; production website functions executed only in isolated Hardhat.`);
});
