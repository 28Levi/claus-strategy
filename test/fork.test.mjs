import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { BrowserProvider, Contract, JsonRpcSigner, keccak256, toBeHex, ZeroAddress } from 'ethers';
import hre from 'hardhat';
import { deploy, E, treasuryConfig, tx } from './helper.mjs';

// All writes below use Hardhat's in-process EVM. The external RPC is only a
// read-only source for this exact historical state; there is no remote signer.
const RPC = process.env.CLAUS_FORK_RPC;
const PIN = {
  block: 26_154_369,
  hash: '0xe37b850c5c182cdf1b868af39bcf2606d9ae52a9213e5b42a1004e99ff0269d7',
  collection: '0x80396c7131159eB92E7E84839e51C9887A7A95d9',
  collectionCodeHash: '0x162a8f628e26a75e99b59459595aa3dab79d928bab90263195364a48d91a8212',
  market: '0x7832B1B34B8dBec979a44634BC095821c91FFc95',
  marketCodeHash: '0x63865e754617b5ee85e3da800d2de79fe5728eacc9573ce0d560f37e5e8ee2a3',
  tokenId: 1n,
};

const NFT_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function approve(address,uint256)',
  'function getApproved(uint256) view returns (address)',
  'function isApprovedForAll(address,address) view returns (bool)',
  'function transferFrom(address,address,uint256)',
  'function transferNonce(uint256) view returns (uint256)',
  'function CAPACITY() view returns (uint256)',
  'function epochStart() view returns (uint64)',
  'function currentEpoch() view returns (uint256)',
  'function epochPot(uint256) view returns (uint256)',
  'function holdingSeconds(address,uint256) view returns (uint256)',
  'function owed(address,uint256) view returns (uint256)',
  'function paid(uint256,address) view returns (uint256)',
  'function payRewards(uint256,address[])',
];
const MARKET_ABI = [
  'function collection() view returns (address)',
  'function FEE_BPS() view returns (uint256)',
  'function list(uint256,uint256)',
  'function isActive(uint256) view returns (bool)',
  'function listings(uint256) view returns (address seller,uint256 price,uint256 transferNonce,uint256 revision)',
];

test('pinned mainnet Claus custody, reward checkpoints, and 1.1x sale work on a local fork', {
  skip: RPC ? false : 'Set CLAUS_FORK_RPC to an Ethereum archive RPC to run the optional local fork test.',
  timeout: 180_000,
}, async t => {
  // Check identity against the launch template, not merely a similarly named NFT.
  const config = JSON.parse(await readFile(new URL('../config/programmable.example.json', import.meta.url), 'utf8'));
  assert.equal(config.nftCollection.address.toLowerCase(), PIN.collection.toLowerCase());
  // This historical fixture covers the legacy native venue, not the default OpenSea adapter.
  assert.equal(config.strategy.acquisitionVenue, 'opensea');

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
  const block = await provider.getBlock(PIN.block);
  assert.equal(block.hash, PIN.hash, 'Fork block must match the pinned Ethereum block hash');
  assert.equal(keccak256(await provider.getCode(PIN.collection)), PIN.collectionCodeHash);
  assert.equal(keccak256(await provider.getCode(PIN.market)), PIN.marketCodeHash);
  t.diagnostic(`Ethereum fork block ${PIN.block} (${PIN.hash}); collection ${PIN.collection}; market ${PIN.market}. All writes are local.`);

  const admin = await provider.getSigner(0);
  const buyer = await provider.getSigner(1);
  const keeper = await provider.getSigner(2);
  const adminAddress = await admin.getAddress();
  const buyerAddress = await buyer.getAddress();
  const nft = new Contract(PIN.collection, NFT_ABI, provider);
  const market = new Contract(PIN.market, MARKET_ABI, provider);
  assert.equal((await market.collection()).toLowerCase(), PIN.collection.toLowerCase());
  assert.equal(await market.FEE_BPS(), 200n);
  assert.equal(await nft.CAPACITY(), 300n);

  const token = await deploy('StrategyToken', admin, ['Fork strategy', 'FORK', E('1000000000'), adminAddress]);
  const treasury = await deploy('StrategyTreasury', admin, [treasuryConfig({
    token: token.target, nft: PIN.collection, market: PIN.market, initializer: adminAddress,
    firstTokenId: PIN.tokenId, tokenCount: 1, maxInventory: 1,
  })]);
  const executor = await deploy('MockExecutor', admin, [token.target, treasury.target]);
  await tx(treasury.initializeHook(executor.target));

  // Impersonation is confined to this checked local EVM. Re-list one already
  // minted NFT so execution does not depend on a live seller keeping an order open.
  const owner = await nft.ownerOf(PIN.tokenId);
  await provider.send('hardhat_impersonateAccount', [owner]);
  t.after(async () => { try { await provider.send('hardhat_stopImpersonatingAccount', [owner]); } catch {} });
  await provider.send('hardhat_setBalance', [owner, toBeHex(E('100'))]);
  const localOwner = new JsonRpcSigner(provider, owner);
  const price = E('0.1');
  await tx(nft.connect(localOwner).approve(PIN.market, PIN.tokenId));
  await tx(market.connect(localOwner).list(PIN.tokenId, price));
  const listing = await market.listings(PIN.tokenId);
  assert.equal(await market.isActive(PIN.tokenId), true);
  const nonceBefore = await nft.transferNonce(PIN.tokenId);

  await tx(executor.fee({ value: E('1') }));
  const purchase = await tx(treasury.connect(keeper).purchaseCheapest(PIN.tokenId, listing.revision));
  const purchaseBlock = await provider.getBlock(purchase.blockNumber);
  assert.equal(await nft.ownerOf(PIN.tokenId), treasury.target);
  assert.equal(await nft.transferNonce(PIN.tokenId), nonceBefore + 1n);
  assert.equal(await nft.getApproved(PIN.tokenId), ZeroAddress);
  assert.equal(await nft.isApprovedForAll(treasury.target, PIN.market), false);
  assert.equal(await nft.isApprovedForAll(treasury.target, adminAddress), false);
  assert.equal(await treasury.acquisitionBalance(), E('0.9'));
  assert.equal(await treasury.buybackBalance(), 0n);
  const position = await treasury.positions(PIN.tokenId);
  assert.equal(position.cost, price);
  assert.equal(position.ask, E('0.11'));
  await assert.rejects(nft.connect(admin).transferFrom.staticCall(treasury.target, adminAddress, PIN.tokenId));

  // Use the real, already funded reward pot and genuine collection checkpoints;
  // no collection code/storage replacement or artificial reward injection.
  const epoch = await nft.currentEpoch();
  assert.ok(await nft.epochPot(epoch) > 0n, 'Pinned reward epoch must contain real accrued rewards');
  const epochStart = await nft.epochStart();
  const epochEnd = epochStart + (epoch + 1n) * 86400n;
  await provider.send('evm_setNextBlockTimestamp', [Number(epochEnd + 1n)]);
  await provider.send('evm_mine', []);
  assert.equal(await nft.holdingSeconds(treasury.target, epoch), epochEnd - BigInt(purchaseBlock.timestamp));
  const owed = await nft.owed(treasury.target, epoch);
  assert.ok(owed > 0n);
  await tx(nft.connect(keeper).payRewards(epoch, [treasury.target]));
  assert.equal(await nft.paid(epoch, treasury.target), owed);
  assert.equal(await nft.owed(treasury.target, epoch), 0n);
  assert.equal(await treasury.acquisitionBalance(), E('0.9') + owed);
  assert.equal(await treasury.buybackBalance(), 0n);

  await tx(treasury.connect(buyer).buyNFT(PIN.tokenId, buyerAddress, { value: position.ask }));
  assert.equal(await nft.ownerOf(PIN.tokenId), buyerAddress);
  assert.equal(await nft.transferNonce(PIN.tokenId), nonceBefore + 2n);
  assert.equal(await nft.getApproved(PIN.tokenId), ZeroAddress);
  assert.equal(await treasury.inventoryCount(), 0n);
  assert.equal(await treasury.buybackBalance(), position.ask);
  assert.equal(await treasury.acquisitionBalance(), E('0.9') + owed);
  assert.equal(await treasury.totalSaleProceeds(), position.ask);
  const saleEpoch = await nft.currentEpoch();
  const historicalHolding = await nft.holdingSeconds(treasury.target, saleEpoch);
  await provider.send('evm_increaseTime', [600]);
  await provider.send('evm_mine', []);
  assert.equal(await nft.holdingSeconds(treasury.target, saleEpoch), historicalHolding);
  assert.ok(await nft.holdingSeconds(buyerAddress, saleEpoch) >= 600n);
  const balance = BigInt(await provider.send('eth_getBalance', [treasury.target, 'latest']));
  assert.equal(balance, await treasury.acquisitionBalance() + await treasury.buybackBalance());
  t.diagnostic(`Acquired Claus #${PIN.tokenId} for ${price} wei, received ${owed} wei actual historical rewards, and sold for ${position.ask} wei with no treasury approval.`);
});
