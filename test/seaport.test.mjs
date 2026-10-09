import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress, ZeroHash } from 'ethers';
import { tx, E, deploy } from './helper.mjs';
import { seaportFixture, makeOrder, createConduit } from './seaport-helper.mjs';

test('real Seaport purchases at gross 1.6 ETH including fees, custody, 1.76 resale and supply burn', async t => {
  const f = await seaportFixture(t);
  const q = await makeOrder(f);
  const sellerBefore = await f.balance(f.addresses[1]);
  const feesBefore = await f.balance(f.addresses[5]);
  await tx(f.executor.fee({value:E('1.6')}));
  await assert.rejects(f.market.connect(f.attacker).registerAndPurchase.staticCall(q.order,f.treasury.target));
  await tx(f.market.registerAndPurchase(q.order,f.treasury.target));
  assert.equal(await f.nft.ownerOf(1),f.treasury.target);
  assert.equal(await f.balance(f.addresses[1])-sellerBefore,E('1.56'));
  assert.equal(await f.balance(f.addresses[5])-feesBefore,E('0.04'));
  assert.equal(await f.nft.getApproved(1),ZeroAddress);
  assert.equal(await f.nft.isApprovedForAll(f.treasury.target,f.seaport.target),false);
  await assert.rejects(f.nft.connect(f.admin).transferFrom.staticCall(f.treasury.target,f.addresses[0],1));
  assert.equal((await f.treasury.positions(1)).ask,E('1.76'));
  assert.equal(await f.treasury.acquisitionBalance(),0n);
  assert.equal(await f.market.isActive(1),false);
  await assert.rejects(f.market.registerAndPurchase.staticCall(q.order,f.treasury.target));
  await tx(f.treasury.connect(f.buyer).buyNFT(1,f.addresses[2],{value:E('1.76')}));
  assert.equal(await f.treasury.buybackBalance(),E('1.76'));
  const before = await f.token.totalSupply();
  await tx(f.treasury.executeBuyback());
  assert.ok(await f.token.totalSupply() < before);
  assert.equal(await f.token.totalSupply(),before-await f.treasury.totalTokensBurned());
});

test('real Seaport conduit and restricted-zone purchases are atomic',async t => {
  const f = await seaportFixture(t);
  const conduit = await createConduit(f);
  const q = await makeOrder(f,{...conduit,restricted:true});
  await tx(f.executor.fee({value:E('1.6')}));
  await assert.rejects(f.market.registerOrder.staticCall(q.order));
  const bad = {...q.order,extraData:'0xabcd'};
  await assert.rejects(tx(f.market.registerAndPurchase(bad,f.treasury.target,{gasLimit:15_000_000})));
  assert.equal(await f.market.registeredOrderHash(1),ZeroHash);
  assert.equal((await f.market.listings(1)).revision,0n);
  assert.equal(await f.nft.ownerOf(1),f.addresses[1]);
  assert.equal(await f.treasury.acquisitionBalance(),E('1.6'));
  await tx(f.controller.connect(f.seller).updateChannel(conduit.operator,f.seaport.target,false));
  await assert.rejects(f.market.registerAndPurchase.staticCall(q.order,f.treasury.target));
  await tx(f.controller.connect(f.seller).updateChannel(conduit.operator,f.seaport.target,true));
  await tx(f.zone.setExpectedFulfiller(f.treasury.target));
  await assert.rejects(f.market.registerAndPurchase.staticCall(q.order,f.treasury.target));
  await tx(f.zone.setExpectedFulfiller(f.market.target));
  await tx(f.market.registerAndPurchase(q.order,f.treasury.target));
  assert.equal(await f.nft.ownerOf(1),f.treasury.target);
  assert.equal(await f.nft.isApprovedForAll(f.treasury.target,conduit.operator),false);
});

test('over-budget, wrong collection, variable price, unsigned tips and invalid signatures cannot spend treasury funds',async t => {
  const f = await seaportFixture(t);
  const q = await makeOrder(f);
  await tx(f.executor.fee({value:E('2')}));
  const tooMuch = await makeOrder(f,{id:2n,price:E('1.61')});
  await assert.rejects(f.market.registerAndPurchase.staticCall(tooMuch.order,f.treasury.target));
  const changes = [
    {parameters:{...q.order.parameters,offer:[{...q.order.parameters.offer[0],token:f.token.target}]}},
    {parameters:{...q.order.parameters,consideration:[{...q.order.parameters.consideration[0],endAmount:1n},q.order.parameters.consideration[1]]}},
    {parameters:{...q.order.parameters,totalOriginalConsiderationItems:1}},
    {signature:'0x'+'00'.repeat(65)},
    {numerator:1,denominator:2},
    {parameters:{...q.order.parameters,zone:f.addresses[4]}},
  ];
  for (const patch of changes) await assert.rejects(f.market.registerAndPurchase.staticCall({...q.order,...patch},f.treasury.target));
  assert.equal(await f.treasury.acquisitionBalance(),E('2'));
  assert.equal(await f.nft.ownerOf(1),f.addresses[1]);
});

test('cancellation, counter invalidation, revoked approval and expiry reject before treasury spending',async t => {
  const f = await seaportFixture(t);
  await tx(f.executor.fee({value:E('1.6')}));
  const cancelled = await makeOrder(f);
  await tx(f.seaport.connect(f.seller).cancel([cancelled.components]));
  await assert.rejects(f.market.registerAndPurchase.staticCall(cancelled.order,f.treasury.target));
  const counter = await makeOrder(f,{id:2n});
  await tx(f.seaport.connect(f.seller).incrementCounter());
  await assert.rejects(f.market.registerAndPurchase.staticCall(counter.order,f.treasury.target));
  const revoked = await makeOrder(f,{id:3n});
  await tx(f.nft.connect(f.seller).setApprovalForAll(f.seaport.target,false));
  await assert.rejects(f.market.registerAndPurchase.staticCall(revoked.order,f.treasury.target));
  await tx(f.nft.connect(f.seller).setApprovalForAll(f.seaport.target,true));
  await f.time(3601);
  await assert.rejects(f.market.registerAndPurchase.staticCall(revoked.order,f.treasury.target));
  assert.equal(await f.treasury.acquisitionBalance(),E('1.6'));
});

test('unfillable open orders and fake purchase targets cannot poison the order cache',async t => {
  const f = await seaportFixture(t);
  const reject = await deploy('RejectSeaportPayment',f.admin);
  const fake = await deploy('NoPurchaseTarget',f.admin);
  const bad = await makeOrder(f,{feeRecipient:reject.target});
  await tx(f.executor.fee({value:E('1.6')}));
  await assert.rejects(f.market.registerOrder.staticCall(bad.order));
  await assert.rejects(tx(f.market.registerAndPurchase(bad.order,f.treasury.target,{gasLimit:15_000_000})));
  await assert.rejects(tx(f.market.registerAndPurchase(bad.order,fake.target,{gasLimit:15_000_000})));
  assert.equal(await f.market.registeredOrderHash(1),ZeroHash);
  assert.equal((await f.market.listings(1)).revision,0n);
  const good = await makeOrder(f,{mint:false,salt:2n});
  await tx(f.market.registerAndPurchase(good.order,f.treasury.target));
  assert.equal(await f.nft.ownerOf(1),f.treasury.target);
});

test('uncapped trusted-bot purchases follow higher prices and preserve reserve isolation and affordability',async t => {
  const f = await seaportFixture(t,{config:{maxPurchasePrice:0,maxSpendPerEpoch:0}});
  const first = await makeOrder(f,{price:E('1.6')});
  await tx(f.executor.fee({value:E('1.6')}));
  await tx(f.market.registerAndPurchase(first.order,f.treasury.target));
  await tx(f.treasury.connect(f.buyer).buyNFT(1,f.addresses[2],{value:E('1.76')}));
  await f.time(61);
  const higher = await makeOrder(f,{id:2n,price:E('3')});
  // Sale proceeds cannot fund the next acquisition, even in uncapped mode.
  await assert.rejects(f.market.registerAndPurchase.staticCall(higher.order,f.treasury.target));
  await tx(f.executor.fee({value:E('3')}));
  await tx(f.market.registerAndPurchase(higher.order,f.treasury.target));
  assert.equal((await f.treasury.positions(2)).ask,E('3.3'));
  assert.equal(await f.treasury.spentInEpoch(),E('4.6'));
  assert.equal(await f.treasury.buybackBalance(),E('1.76'));
  assert.equal(await f.treasury.acquisitionBalance(),0n);
});
