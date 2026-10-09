import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { BrowserProvider, Contract, JsonRpcSigner, Wallet, keccak256, toBeHex, ZeroAddress } from 'ethers';
import hre from 'hardhat';
import { artifacts, deploy, E, treasuryConfig, tx } from './helper.mjs';
import { createConduit, makeOrder } from './seaport-helper.mjs';

// Only Hardhat's isolated EVM has a signer. The configured Ethereum RPC supplies
// historical reads; no private key or signed transaction is sent to it.
const RPC = process.env.CLAUS_FORK_RPC;
const PIN = {
  block: 26_154_629,
  hash: '0x5e813eb256463c52afae70691c051b31fb16471881e32e4e74c471dd4c17d0e0',
  collection: '0x80396c7131159eB92E7E84839e51C9887A7A95d9',
  collectionCodeHash: '0x162a8f628e26a75e99b59459595aa3dab79d928bab90263195364a48d91a8212',
  tokenId: 1n,
};
const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function setApprovalForAll(address,bool)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function transferFrom(address,address,uint256)',
  'function transferNonce(uint256) view returns (uint256)',
];

test('canonical mainnet Seaport buys real Claus on an isolated fork with a synthetic uncapped bot order', {
  skip: RPC ? false : 'Set CLAUS_FORK_RPC to an Ethereum archive RPC to run the optional Seaport fork test.',
  timeout: 180_000,
}, async t => {
  const config = JSON.parse(await readFile(new URL('../config/programmable.example.json', import.meta.url), 'utf8'));
  const release = JSON.parse(await readFile(new URL('../config/opensea.ethereum-release.json', import.meta.url), 'utf8'));
  assert.equal(config.nftCollection.address.toLowerCase(), PIN.collection.toLowerCase());
  assert.equal(config.strategy.acquisitionVenue, 'opensea');
  assert.equal(config.strategy.pricingPolicy.mode, 'trusted-bot');
  assert.equal(config.strategy.maxPurchasePriceWei, '0');
  assert.equal(config.strategy.maxSpendPerEpochWei, '0');
  const connection = await hre.network.create({
    network: 'hardhatMainnet',
    override: { chainId: 31337, forking: { url: RPC, blockNumber: PIN.block } },
  });
  assert.equal(connection.networkConfig.type, 'edr-simulated');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  t.after(async () => { provider.destroy(); await connection.close(); });
  assert.equal((await provider.getNetwork()).chainId, 31337n);
  assert.match(await provider.send('web3_clientVersion', []), /Hardhat/i);
  assert.equal((await provider.getBlock(PIN.block)).hash, PIN.hash);
  assert.equal(keccak256(await provider.getCode(PIN.collection)), PIN.collectionCodeHash);
  const dependencyCodeHashes = {};
  for (const key of ['seaport', 'conduitController', 'allowedZone']) {
    const code = await provider.getCode(release[key]);
    assert.notEqual(code, '0x', `Pinned ${key} must have deployed code`);
    dependencyCodeHashes[key] = keccak256(code);
    assert.equal(dependencyCodeHashes[key], release.runtimeCodeHashes[key], `${key} must match the reviewed runtime pin`);
  }

  const signers = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
  const [admin,, buyer, attacker] = signers;
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const seller = Wallet.createRandom().connect(provider);
  addresses[1] = seller.address;
  await provider.send('hardhat_setBalance', [seller.address, toBeHex(E('10'))]);
  const nft = new Contract(PIN.collection, NFT_ABI, provider);
  const seaport = new Contract(release.seaport, artifacts.Seaport.abi, provider);
  const controller = new Contract(release.conduitController, artifacts.ConduitController.abi, provider);
  const info = await seaport.information();
  assert.equal(info[0], '1.6');
  assert.equal(info[2].toLowerCase(), release.conduitController.toLowerCase());

  const market = await deploy('SeaportListingMarket', admin, [
    PIN.collection, release.seaport, release.conduitController, release.allowedZone, addresses[0],
  ]);
  const token = await deploy('StrategyToken', admin, ['Seaport fork strategy', 'SFORK', E('1000000000'), addresses[0]]);
  const treasury = await deploy('StrategyTreasury', admin, [treasuryConfig({
    token: token.target, nft: PIN.collection, market: market.target, initializer: addresses[0],
    firstTokenId: PIN.tokenId, tokenCount: 1, maxInventory: 1, maxPurchasePrice: 0, maxSpendPerEpoch: 0,
  })]);
  const executor = await deploy('MockExecutor', admin, [token.target, treasury.target]);
  await tx(treasury.initializeHook(executor.target));

  // Transfer an existing real NFT only inside the checked fork. The seller is a
  // fresh local wallet signing a synthetic FULL_OPEN order, not a live listing.
  const owner = await nft.ownerOf(PIN.tokenId);
  await provider.send('hardhat_impersonateAccount', [owner]);
  try {
    await provider.send('hardhat_setBalance', [owner, toBeHex(E('10'))]);
    await tx(nft.connect(new JsonRpcSigner(provider, owner)).transferFrom(owner, seller.address, PIN.tokenId));
  } finally {
    await provider.send('hardhat_stopImpersonatingAccount', [owner]);
  }
  assert.equal(await nft.ownerOf(PIN.tokenId), seller.address);
  const conduit = await createConduit({ controller, seaport, seller, addresses });
  const orderFixture = { provider, nft, seaport, seller, addresses, zone: { target: release.allowedZone } };
  const order = await makeOrder(orderFixture, { mint: false, price: E('1.6'), ...conduit });
  assert.equal(order.order.parameters.orderType, 0);
  const nonceBefore = await nft.transferNonce(PIN.tokenId);
  await tx(executor.fee({ value: E('1.6') }));
  await assert.rejects(market.connect(attacker).registerAndPurchase.staticCall(order.order, treasury.target));

  // Hosted OpenSea authorization is unavailable without API access. Verify that
  // a valid seller signature with fake zone authorization cannot bypass the real
  // deployed signed zone or leave a partial acquisition behind.
  const invalidRestricted = await makeOrder(orderFixture, {
    mint: false, price: E('1.6'), restricted: true, salt: 2n, ...conduit,
  });
  await assert.rejects(market.registerAndPurchase.staticCall(invalidRestricted.order, treasury.target));
  assert.equal(await nft.ownerOf(PIN.tokenId), seller.address);
  assert.equal(await treasury.acquisitionBalance(), E('1.6'));
  assert.equal(await treasury.inventoryCount(), 0n);
  const balance = async address => BigInt(await provider.send('eth_getBalance', [address, 'latest']));
  const sellerBefore = await balance(seller.address);
  const feeBefore = await balance(addresses[5]);
  await tx(market.registerAndPurchase(order.order, treasury.target));
  assert.equal(await balance(seller.address) - sellerBefore, E('1.56'));
  assert.equal(await balance(addresses[5]) - feeBefore, E('0.04'));
  assert.equal(await nft.ownerOf(PIN.tokenId), treasury.target);
  assert.equal(await nft.transferNonce(PIN.tokenId), nonceBefore + 1n);
  assert.equal(await nft.getApproved(PIN.tokenId), ZeroAddress);
  assert.equal(await nft.isApprovedForAll(treasury.target, release.seaport), false);
  assert.equal(await nft.isApprovedForAll(treasury.target, conduit.operator), false);
  assert.equal(await nft.isApprovedForAll(treasury.target, addresses[0]), false);
  assert.equal(await treasury.acquisitionBalance(), 0n);
  assert.equal(await treasury.buybackBalance(), 0n);
  const position = await treasury.positions(PIN.tokenId);
  assert.equal(position.cost, E('1.6'));
  assert.equal(position.ask, E('1.76'));
  const status = await seaport.getOrderStatus(order.hash);
  assert.equal(status[1], false);
  assert.ok(status[3] > 0n);
  assert.equal(status[2], status[3]);
  await assert.rejects(nft.connect(admin).transferFrom.staticCall(treasury.target, addresses[0], PIN.tokenId));
  await assert.rejects(market.registerAndPurchase.staticCall(order.order, treasury.target));

  await tx(treasury.connect(buyer).buyNFT(PIN.tokenId, addresses[2], { value: E('1.76') }));
  assert.equal(await nft.ownerOf(PIN.tokenId), addresses[2]);
  assert.equal(await nft.transferNonce(PIN.tokenId), nonceBefore + 2n);
  assert.equal(await treasury.buybackBalance(), E('1.76'));
  assert.equal(await treasury.acquisitionBalance(), 0n);
  assert.equal(await treasury.inventoryCount(), 0n);
  assert.equal(await balance(treasury.target), E('1.76'));

  const proof = {
    scope: 'isolated Hardhat fork; real deployed Seaport and Claus; synthetic locally signed FULL_OPEN order',
    sourceChainId: 1, executionChainId: 31337,
    checkedAt: new Date().toISOString(), blockNumber: PIN.block, blockHash: PIN.hash,
    collection: PIN.collection, collectionCodeHash: PIN.collectionCodeHash,
    seaport: release.seaport, conduitController: release.conduitController, allowedZone: release.allowedZone,
    dependencyCodeHashes, purchasePriceWei: E('1.6').toString(), resalePriceWei: E('1.76').toString(),
    fixedPurchaseLimitWei: '0', fixedEpochLimitWei: '0', custodyVerified: true, trustedBotVerified: true,
    canonicalConduitFulfilled: true, invalidOpenSeaZoneAuthorizationRejected: true,
    openSeaApiUsed: false, openSeaSignedZoneAuthorizationTested: false, mainnetWrites: false,
  };
  await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
  await writeFile(new URL('../artifacts/seaport-fork-test-proof.json', import.meta.url), `${JSON.stringify(proof, null, 2)}\n`);
  t.diagnostic(`Fork block ${PIN.block}: canonical Seaport acquired real Claus #1 for 1.6 ETH and the treasury sold for 1.76 ETH. Synthetic order; all writes local.`);
});
