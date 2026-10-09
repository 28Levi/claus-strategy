#!/usr/bin/env node
// Opt-in real-listing verification. Ethereum RPC supplies reads only. Every
// deployment, payment and NFT transfer uses a new in-process Hardhat EVM.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserProvider, Contract, keccak256, toBeHex, toQuantity, ZeroAddress } from 'ethers';
import hre from 'hardhat';
import { artifacts, deploy, E, treasuryConfig, tx } from '../test/helper.mjs';
import { fetchBestListingOrders } from './opensea.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NFT_ABI = [
  'function ownerOf(uint256) view returns(address)',
  'function getApproved(uint256) view returns(address)',
  'function isApprovedForAll(address,address) view returns(bool)',
  'function transferFrom(address,address,uint256)',
];
const readJson = async name => JSON.parse(await fs.readFile(path.join(ROOT, name), 'utf8'));

export function parseForkArgs(argv) {
  if (argv.length === 1 && argv[0] === '--capture-pin') return { capturePin: true };
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--require-restricted') {
      if (options.requireRestricted) throw new Error('Duplicate option');
      options.requireRestricted = true;
    } else if (flag === '--block' || flag === '--hash') {
      const key = flag === '--block' ? 'blockNumber' : 'blockHash';
      if (options[key] !== undefined || argv[i + 1] === undefined) throw new Error('Duplicate or missing option');
      options[key] = argv[++i];
    } else throw new Error('Unknown option');
  }
  if (!/^[1-9][0-9]*$/.test(options.blockNumber ?? '') || !Number.isSafeInteger(Number(options.blockNumber))) {
    throw new Error('An explicit positive --block is required');
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(options.blockHash ?? '')) throw new Error('An explicit 32-byte --hash is required');
  return { ...options, blockNumber: Number(options.blockNumber), blockHash: options.blockHash.toLowerCase() };
}

export function requireForkEnvironment(options, environment = process.env) {
  if (!environment.CLAUS_FORK_RPC) throw new Error('CLAUS_FORK_RPC is required');
  let rpc;
  try { rpc = new URL(environment.CLAUS_FORK_RPC); } catch { throw new Error('CLAUS_FORK_RPC must be a valid URL'); }
  if (rpc.protocol !== 'https:' && !(rpc.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(rpc.hostname))) {
    throw new Error('CLAUS_FORK_RPC must use HTTPS or local HTTP');
  }
  if (!options.capturePin && (!environment.OPENSEA_API_KEY || /[\r\n]/.test(environment.OPENSEA_API_KEY))) {
    throw new Error('OPENSEA_API_KEY is required; configure it locally, never in a command argument');
  }
  return { rpc: environment.CLAUS_FORK_RPC, apiKey: environment.OPENSEA_API_KEY };
}

// No transaction submission method is exposed on this remote reader.
export async function readEthereumPin(rpc, options, fetchImpl = fetch) {
  async function read(method, params) {
    const response = await fetchImpl(rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      redirect: 'error', signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Ethereum read failed with HTTP ${Number(response.status) || 0}`);
    const data = await response.json();
    if (data.error || data.result === undefined) throw new Error('Ethereum read returned an RPC error');
    return data.result;
  }
  assert.equal(await read('eth_chainId', []), '0x1', 'Fork source must be Ethereum mainnet');
  const block = await read('eth_getBlockByNumber', [options.capturePin ? 'latest' : toQuantity(options.blockNumber), false]);
  assert.ok(block && /^0x[0-9a-fA-F]{64}$/.test(block.hash ?? ''), 'Ethereum block is unavailable');
  const pin = { blockNumber: Number(BigInt(block.number)), blockHash: block.hash.toLowerCase() };
  assert.ok(Number.isSafeInteger(pin.blockNumber) && pin.blockNumber > 0, 'Invalid Ethereum block number');
  if (!options.capturePin) {
    assert.equal(pin.blockNumber, options.blockNumber, 'Fork block number differs from explicit pin');
    assert.equal(pin.blockHash, options.blockHash, 'Fork block hash differs from explicit pin');
  }
  return pin;
}

export async function verifyOpenSeaFork(options, environment = process.env) {
  const { rpc, apiKey } = requireForkEnvironment(options, environment);
  const pin = await readEthereumPin(rpc, options);
  if (options.capturePin) return { sourceChainId: 1, ...pin, scope: 'read-only block capture; not a fulfillment test' };

  const [config, manifest, release] = await Promise.all([
    readJson('config/programmable.example.json'), readJson('config/deployment.example.json'),
    readJson('config/opensea.ethereum-release.json'),
  ]);
  assert.equal(config.strategy.acquisitionVenue, 'opensea');
  assert.equal(config.strategy.pricingPolicy.mode, 'trusted-bot');
  assert.equal(config.strategy.maxPurchasePriceWei, '0');
  assert.equal(config.strategy.maxSpendPerEpochWei, '0');
  const connection = await hre.network.create({
    network: 'hardhatMainnet',
    // Real maker/zone signatures use Ethereum's domain. Chain 31337 would make
    // their signatures invalid. Safety is established by the checked local EVM,
    // never by assuming that chain ID 1 means a remote transaction destination.
    override: { chainId: 1, forking: { url: rpc, blockNumber: pin.blockNumber } },
  });
  let provider;
  try {
    assert.equal(connection.networkConfig.type, 'edr-simulated');
    provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 10;
    assert.match(await provider.send('web3_clientVersion', []), /Hardhat/i);
    assert.equal((await provider.getNetwork()).chainId, 1n);
    assert.equal((await provider.getBlock(pin.blockNumber)).hash, pin.blockHash);
    const dependencyCodeHashes = {};
    for (const key of ['collection', 'seaport', 'conduitController', 'allowedZone']) {
      const dependency = manifest.contracts[key];
      assert.match(dependency.runtimeCodeHash ?? '', /^0x[0-9a-fA-F]{64}$/, `${key} runtime pin is missing`);
      const code = await provider.getCode(dependency.address);
      assert.notEqual(code, '0x');
      dependencyCodeHashes[key] = keccak256(code);
      assert.equal(dependencyCodeHashes[key], dependency.runtimeCodeHash, `${key} runtime differs from reviewed pin`);
      assert.equal(dependency.address.toLowerCase(), (key === 'collection' ? config.nftCollection.address : release[key]).toLowerCase());
    }

    // These are Hardhat-local unlocked accounts. There is no external signer,
    // external Wallet, remote transaction provider or user private key here.
    const [bot, buyer, attacker] = await Promise.all([0, 1, 2].map(i => provider.getSigner(i)));
    const [botAddress, buyerAddress, attackerAddress] = await Promise.all([bot, buyer, attacker].map(s => s.getAddress()));
    const nft = new Contract(config.nftCollection.address, NFT_ABI, provider);
    const seaport = new Contract(release.seaport, artifacts.Seaport.abi, provider);
    const info = await seaport.information();
    assert.equal(info[0], '1.6');
    assert.equal(info[2].toLowerCase(), release.conduitController.toLowerCase());
    const market = await deploy('SeaportListingMarket', bot, [
      nft.target, release.seaport, release.conduitController, release.allowedZone, botAddress,
    ]);
    const token = await deploy('StrategyToken', bot, ['Local OpenSea verification', 'LOCAL', E('1000000000'), botAddress]);
    const treasury = await deploy('StrategyTreasury', bot, [treasuryConfig({
      token: token.target, nft: nft.target, market: market.target, initializer: botAddress,
      firstTokenId: BigInt(config.strategy.firstTokenId), tokenCount: config.strategy.tokenCount,
      maxPurchasePrice: 0, maxSpendPerEpoch: 0, minPurchaseInterval: config.strategy.minPurchaseIntervalSeconds,
      maxInventory: config.strategy.maxInventory,
    })]);
    const executor = await deploy('MockExecutor', bot, [token.target, treasury.target]);
    await tx(treasury.initializeHook(executor.target));

    const discovery = await fetchBestListingOrders({
      apiKey, collectionSlug: config.strategy.collectionSlug, collectionAddress: nft.target,
      marketAddress: market.target, treasuryAddress: treasury.target, seaportAddress: release.seaport,
      allowedZoneAddress: release.allowedZone, firstTokenId: BigInt(config.strategy.firstTokenId),
      tokenCount: config.strategy.tokenCount, maxCandidates: 3,
    });
    const candidates = discovery.candidates.filter(candidate => !options.requireRestricted || candidate.advancedOrder.parameters.orderType === 2);
    assert.ok(candidates.length, options.requireRestricted
      ? 'No supported restricted OpenSea listing was returned; signed-zone verification did not run'
      : 'No supported OpenSea listing was returned; fulfillment verification did not run');
    const reserve = candidates.reduce((max, candidate) => candidate.priceWei > max ? candidate.priceWei : max, 0n);
    await provider.send('hardhat_setBalance', [botAddress, toBeHex(reserve + E('100'))]);
    await tx(executor.fee({ value: reserve }));

    let purchase;
    const rejectedSimulations = [];
    for (const candidate of candidates) {
      try {
        await market.registerAndPurchase.staticCall(candidate.advancedOrder, treasury.target);
      } catch {
        rejectedSimulations.push(candidate.orderHash);
        continue;
      }
      await assert.rejects(market.connect(attacker).registerAndPurchase.staticCall(candidate.advancedOrder, treasury.target));
      const receipt = await tx(market.registerAndPurchase(candidate.advancedOrder, treasury.target));
      purchase = { candidate, receipt };
      break;
    }
    assert.ok(purchase, 'Every live candidate failed isolated fulfillment; no success proof produced');
    const { candidate, receipt } = purchase;
    const position = await treasury.positions(candidate.tokenId);
    const expectedAsk = (candidate.priceWei * 11000n + 9999n) / 10000n;
    assert.equal(await nft.ownerOf(candidate.tokenId), treasury.target);
    assert.equal(position.cost, candidate.priceWei);
    assert.equal(position.ask, expectedAsk);
    assert.equal(await nft.getApproved(candidate.tokenId), ZeroAddress);
    assert.equal(await nft.isApprovedForAll(treasury.target, release.seaport), false);
    assert.equal(await nft.isApprovedForAll(treasury.target, botAddress), false);
    assert.equal(await treasury.acquisitionBalance(), reserve - candidate.priceWei);
    assert.equal(await treasury.buybackBalance(), 0n);
    await assert.rejects(nft.connect(bot).transferFrom.staticCall(treasury.target, attackerAddress, candidate.tokenId));
    await assert.rejects(market.registerAndPurchase.staticCall(candidate.advancedOrder, treasury.target));
    const status = await seaport.getOrderStatus(candidate.orderHash);
    assert.equal(status[1], false);
    assert.ok(status[3] > 0n);
    assert.equal(status[2], status[3]);

    await provider.send('hardhat_setBalance', [buyerAddress, toBeHex(expectedAsk + E('100'))]);
    await tx(treasury.connect(buyer).buyNFT(candidate.tokenId, buyerAddress, { value: expectedAsk }));
    assert.equal(await nft.ownerOf(candidate.tokenId), buyerAddress);
    assert.equal(await treasury.buybackBalance(), expectedAsk);
    assert.equal(await treasury.acquisitionBalance(), reserve - candidate.priceWei);
    assert.equal(await treasury.inventoryCount(), 0n);
    const treasuryBalance = BigInt(await provider.send('eth_getBalance', [treasury.target, 'latest']));
    assert.equal(treasuryBalance, reserve - candidate.priceWei + expectedAsk);

    const proof = {
      scope: 'hosted OpenSea discovery and fulfillment payload; actual order on isolated Hardhat fork; mock fee executor',
      checkedAt: new Date().toISOString(), sourceChainId: 1, executionChainId: 1, executionClient: 'Hardhat EDR simulated',
      ...pin, dependencyCodeHashes, collection: nft.target, seaport: release.seaport,
      orderHash: candidate.orderHash, tokenId: candidate.tokenId.toString(), orderType: candidate.advancedOrder.parameters.orderType,
      purchasePriceWei: candidate.priceWei.toString(), resalePriceWei: expectedAsk.toString(),
      purchaseGasUsed: receipt.gasUsed.toString(), openSeaApiUsed: true,
      openSeaSignedZoneAuthorizationTested: candidate.advancedOrder.parameters.orderType === 2,
      custodyVerified: true, trustedBotVerified: true, fixedPurchaseLimitWei: '0', fixedEpochLimitWei: '0',
      rejectedSimulations, boundedListingScan: true, mainnetWrites: false,
    };
    const directory = path.join(ROOT, 'artifacts');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'opensea-live-fork-proof.json'), `${JSON.stringify(proof, null, 2)}\n`);
    return proof;
  } finally {
    provider?.destroy();
    await connection.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const proof = await verifyOpenSeaFork(parseForkArgs(process.argv.slice(2)));
    console.log(JSON.stringify(proof, null, 2));
  } catch (error) {
    // Do not print RPC URLs, request headers, order signatures or error objects.
    const message = String(error.message).replaceAll(process.env.CLAUS_FORK_RPC || '\0', '[RPC URL]')
      .replaceAll(process.env.OPENSEA_API_KEY || '\0', '[API key]')
      .replace(/https?:\/\/[^\s"'<>]+/g, '[URL]');
    console.error(`OpenSea fork verification failed: ${message.slice(0, 1000)}`);
    process.exitCode = 1;
  }
}
