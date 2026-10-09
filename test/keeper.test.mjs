import test from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, ZeroHash } from 'ethers';
import { inspectActions, inspectOpenSeaActions, verifyDeployment, gasBudget } from '../scripts/keeper.mjs';
import { normalizeOpenSeaFulfillment } from '../scripts/opensea.mjs';
import { seaportFixture, makeOrder } from './seaport-helper.mjs';
import { fixture, v4Fixture, tx, E } from './helper.mjs';

test('keeper discovers only currently executable work and enforces gas ceilings', async t => {
  const f = await fixture(t);
  await f.list();
  let now = (await f.provider.getBlock('latest')).timestamp;
  assert.equal((await inspectActions(f.treasury, now)).actions.length, 0);
  await tx(f.executor.fee({ value: E('0.1') }));
  now = (await f.provider.getBlock('latest')).timestamp;
  assert.deepEqual((await inspectActions(f.treasury, now)).actions.map(a => a.method), ['purchaseCheapest']);
  assert.equal(gasBudget(100n, 2n, 240n), 120n);
  assert.throws(() => gasBudget(100n, 2n, 239n), /exceeds/);
});

test('keeper refuses another chain, missing bindings and changed contract bytecode', async t => {
  const f = await fixture(t);
  const manifest = { chainId: 31337, contracts: {} };
  for (const [role, address] of Object.entries({ treasury: f.treasury.target, hook: f.executor.target,
    token: f.token.target, collection: f.nft.target, market: f.market.target, initializer: f.addresses[0] })) {
    manifest.contracts[role] = { address, runtimeCodeHash: keccak256(await f.provider.getCode(address)) };
  }
  await assert.rejects(verifyDeployment(f.provider, f.treasury, { ...manifest, chainId: 1 }), /chain/);
  await assert.rejects(verifyDeployment(f.provider, f.treasury, { chainId: 31337 }), /Missing/);
  // This fixture deliberately has an EOA initializer; production requires exact contract code.
  await assert.rejects(verifyDeployment(f.provider, f.treasury, manifest), /initializer/);
  manifest.contracts.treasury.runtimeCodeHash = '0x' + '00'.repeat(32);
  await assert.rejects(verifyDeployment(f.provider, f.treasury, manifest), /Runtime mismatch/);
});

function apiCandidate(f, built, now) {
  const {order,hash,price,id} = built;
  // Schema-valid synthetic OpenSea response wrapping a real local Seaport signed order.
  // API chain metadata is Ethereum; signature execution is on the isolated local chain.
  const listing = {chain:'ethereum',status:'ACTIVE',remaining_quantity:1,type:'basic',
    order_hash:hash,protocol_address:f.seaport.target,protocol_data:{parameters:order.parameters,signature:null},
    asset:{contract:f.nft.target,identifier:id.toString()},
    price:{current:{currency:'ETH',decimals:18,value:price.toString()}}};
  return normalizeOpenSeaFulfillment({listing,
    fulfillment:{protocol:'seaport',fulfillment_data:{orders:[{parameters:order.parameters,signature:order.signature}],
      transaction:{chain:1,to:f.seaport.target,value:price.toString(),function:'fulfillAdvancedOrder',
        input_data:{advancedOrder:order,criteriaResolvers:[],fulfillerConduitKey:ZeroHash,recipient:f.treasury.target}}}},
    collectionAddress:f.nft.target,marketAddress:f.market.target,treasuryAddress:f.treasury.target,
    seaportAddress:f.seaport.target,allowedZoneAddress:f.zone.target,nowSeconds:now});
}

test('OpenSea keeper simulates as the immutable bot and buys a signed order above the old cap without exposing custody', async t => {
  const f = await seaportFixture(t,{config:{maxPurchasePrice:0,maxSpendPerEpoch:0}});
  const built = await makeOrder(f,{price:E('2.4'),restricted:true});
  await tx(f.executor.fee({value:E('2.4')}));
  const now = (await f.provider.getBlock('latest')).timestamp;
  const candidate = apiCandidate(f,built,now);
  assert.equal(candidate.orderHash,built.hash); // Independently computed against real Seaport.getOrderHash.
  let request;
  const result = await inspectOpenSeaActions(f.treasury,f.market.connect(f.provider),
    {acquisition:{venue:'opensea',collectionSlug:'contractclaus'}},now,async args => {
      request = args;
      return {candidates:[candidate],rejected:[],source:{marketplace:'OpenSea'}};
    });
  assert.equal(request.marketAddress,f.market.target);
  assert.equal(request.treasuryAddress,f.treasury.target);
  assert.equal(request.allowedZoneAddress,f.zone.target);
  assert.equal(result.actions.length,1);
  assert.equal(result.actions[0].method,'registerAndPurchase');
  assert.equal(result.actions[0].nftPriceWei,E('2.4').toString());
  const connected = await inspectOpenSeaActions(f.treasury.connect(f.admin),f.market.connect(f.admin),
    {acquisition:{venue:'opensea',collectionSlug:'contractclaus'}},now,
    async () => ({candidates:[candidate],rejected:[],source:{marketplace:'OpenSea'}}));
  assert.equal(connected.actions.length,1); // A matching signer permits the explicit eth_call from override.
  assert.equal(await f.nft.ownerOf(built.id),f.addresses[1]); // Inspection cannot buy.
  const action = result.actions[0];
  await tx(f.market.connect(f.admin).registerAndPurchase(...action.args));
  assert.equal(await f.nft.ownerOf(built.id),f.treasury.target);
  assert.equal(await f.market.registeredOrderHash(built.id),ZeroHash);
  assert.equal(await f.treasury.acquisitionBalance(),0n);
  assert.equal((await f.treasury.positions(built.id)).ask,E('2.64'));
});

test('OpenSea keeper skips stale signed orders and preserves available acquisition funds', async t => {
  const f = await seaportFixture(t,{config:{maxPurchasePrice:0,maxSpendPerEpoch:0}});
  const stale = await makeOrder(f,{id:1n,price:E('1.6')});
  const valid = await makeOrder(f,{id:2n,price:E('1.7')});
  await tx(f.executor.fee({value:E('1.7')}));
  await tx(f.seaport.connect(f.seller).cancel([stale.components]));
  const now = (await f.provider.getBlock('latest')).timestamp;
  const result = await inspectOpenSeaActions(f.treasury,f.market.connect(f.provider),
    {acquisition:{venue:'opensea',collectionSlug:'contractclaus'}},now,async () => ({
      candidates:[apiCandidate(f,stale,now),apiCandidate(f,valid,now)],rejected:[],source:{marketplace:'OpenSea'},
    }));
  assert.equal(result.actions.length,1);
  assert.equal(result.actions[0].orderHash,valid.hash);
  assert.match(result.skipped[0],/no longer executable/);
  assert.equal(await f.treasury.acquisitionBalance(),E('1.7'));
  assert.equal(await f.nft.ownerOf(1),f.addresses[1]);
  assert.equal(await f.nft.ownerOf(2),f.addresses[1]);
});

test('OpenSea keeper waits for fees and refuses orders above cash even when the permanent price cap is disabled', async t => {
  const f = await seaportFixture(t,{config:{maxPurchasePrice:0,maxSpendPerEpoch:0}});
  const built = await makeOrder(f,{price:E('3')});
  let now = (await f.provider.getBlock('latest')).timestamp;
  let requests = 0;
  const fetch = async () => { requests++; return {candidates:[apiCandidate(f,built,now)],rejected:[],source:{}}; };
  const manifest = {acquisition:{venue:'opensea',collectionSlug:'contractclaus'}};
  assert.equal((await inspectOpenSeaActions(f.treasury,f.market.connect(f.provider),manifest,now,fetch)).actions.length,0);
  assert.equal(requests,0);
  await tx(f.executor.fee({value:E('2')}));
  now = (await f.provider.getBlock('latest')).timestamp;
  const result = await inspectOpenSeaActions(f.treasury,f.market.connect(f.provider),manifest,now,fetch);
  assert.equal(requests,1);
  assert.equal(result.actions.length,0);
  assert.match(result.skipped.at(-1),/affordable/);
  assert.equal(await f.treasury.acquisitionBalance(),E('2'));
});

test('keeper verifies deployed OpenSea dependencies and rejects changed purchase-bot and zone bindings', async t => {
  const f = await v4Fixture(t,{market:'opensea',mode:'token-only',config:{maxPurchasePrice:0,maxSpendPerEpoch:0}});
  const manifest = {chainId:Number((await f.provider.getNetwork()).chainId),contracts:{},
    acquisition:{venue:'opensea',collectionSlug:'contractclaus',purchaseBotAddress:await f.market.purchaseBot()}};
  const roles = {treasury:f.treasury.target,hook:f.hook.target,token:f.token.target,collection:f.nft.target,
    market:f.market.target,initializer:f.initializer.target,poolManager:f.manager.target,
    seaport:f.seaport.target,conduitController:f.controller.target,allowedZone:f.zone.target};
  for (const [role,address] of Object.entries(roles)) {
    manifest.contracts[role] = {address,runtimeCodeHash:keccak256(await f.provider.getCode(address))};
  }
  await verifyDeployment(f.provider,f.treasury,manifest);
  const wrongBot = structuredClone(manifest);
  wrongBot.acquisition.purchaseBotAddress = f.addresses[1];
  await assert.rejects(verifyDeployment(f.provider,f.treasury,wrongBot),/purchase bot binding/);
  const missingZoneHash = structuredClone(manifest);
  delete missingZoneHash.contracts.allowedZone.runtimeCodeHash;
  await assert.rejects(verifyDeployment(f.provider,f.treasury,missingZoneHash),/allowedZone binding/);
  const missingVenue = structuredClone(manifest);
  delete missingVenue.acquisition.venue;
  await assert.rejects(verifyDeployment(f.provider,f.treasury,missingVenue),/OpenSea acquisition manifest/);
});
