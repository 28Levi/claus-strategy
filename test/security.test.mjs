import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deploy, tx, E, ZeroAddress } from './helper.mjs';

async function assertAccounting(f, acquisition, buyback) {
  assert.equal(await f.treasury.acquisitionBalance(), acquisition);
  assert.equal(await f.treasury.buybackBalance(), buyback);
  assert.equal(await f.balance(f.treasury.target), acquisition + buyback);
}

test('binding rejects outsiders, wrong executor identities, repeated initialization, and unsolicited fee calls', async t => {
  const f = await fixture(t, { initialize: false });
  await assert.rejects(f.treasury.connect(f.attacker).initializeHook(f.executor.target));
  await assert.rejects(f.treasury.recordFees({ value: 1n }));
  const wrongToken = await deploy('MockExecutor', f.admin, [f.nft.target, f.treasury.target]);
  const wrongTreasury = await deploy('MockExecutor', f.admin, [f.token.target, f.addresses[1]]);
  await assert.rejects(f.treasury.initializeHook(wrongToken.target));
  await assert.rejects(f.treasury.initializeHook(wrongTreasury.target));
  await assert.rejects(f.treasury.initializeHook(f.addresses[2]));
  assert.equal(await f.treasury.hook(), ZeroAddress);
  await tx(f.admin.sendTransaction({ to: f.treasury.target, value: E('1') }));
  await f.list();
  await assert.rejects(f.purchase());
  await tx(f.treasury.initializeHook(f.executor.target));
  await assert.rejects(f.treasury.initializeHook(f.executor.target));
  await assert.rejects(f.treasury.connect(f.attacker).recordFees({ value: 1n }));
  await assertAccounting(f, E('1'), 0n);
});

test('NFT recipient callbacks cannot reenter any treasury trade or double-count paid ETH', async t => {
  const f = await fixture(t);
  await tx(f.executor.fee({ value: E('1') }));
  await f.list();
  await f.purchase();
  const receiver = await deploy('ReentrantNFTBuyer', f.attacker, [f.treasury.target]);
  const ask = (await f.treasury.positions(1)).ask;
  await tx(receiver.buy(1, { value: ask }));
  assert.equal(await receiver.callbacks(), 1n);
  assert.equal(await receiver.unexpectedSuccesses(), 0n);
  assert.equal(await f.nft.ownerOf(1), receiver.target);
  assert.equal(await f.treasury.inventoryCount(), 0n);
  await assertAccounting(f, E('0.9'), E('0.11'));

  // MockExecutor also calls accountSurplus while the buyback's ETH is in flight.
  const supplyBefore = await f.token.totalSupply();
  await tx(f.treasury.connect(f.attacker).executeBuyback());
  await assertAccounting(f, E('0.9'), 0n);
  assert.equal(supplyBefore - await f.token.totalSupply(), E('110'));
  assert.equal(await f.treasury.totalTokensBurned(), E('110'));
  assert.equal(await f.token.balanceOf(f.treasury.target), 0n);
});

test('recipient rejection atomically restores custody, the position, and both ETH ledgers', async t => {
  const f = await fixture(t);
  await tx(f.executor.fee({ value: E('1') }));
  await f.list();
  await f.purchase();
  const receiver = await deploy('ReentrantNFTBuyer', f.buyer, [f.treasury.target]);
  await tx(receiver.configure(true));
  const before = await f.treasury.positions(1);
  await assert.rejects(tx(receiver.buy(1, { value: before.ask, gasLimit: 1_000_000 })));
  assert.equal(await f.nft.ownerOf(1), f.treasury.target);
  const after = await f.treasury.positions(1);
  assert.equal(after.cost, before.cost);
  assert.equal(after.ask, before.ask);
  assert.equal(await f.treasury.inventoryCount(), 1n);
  assert.equal(await f.treasury.totalSaleProceeds(), 0n);
  assert.equal(await receiver.callbacks(), 0n);
  await assertAccounting(f, E('0.9'), 0n);
});

test('forced ETH becomes acquisition budget exactly once and never buyback proceeds', async t => {
  const f = await fixture(t);
  await tx(f.executor.fee({ value: E('0.2') }));
  const force = await deploy('ForceETH', f.attacker);
  // Hardhat balance assignment supplies a contract with no receive function.
  await f.provider.send('hardhat_setBalance', [force.target, '0x058d15e176280000']); // 0.4 ETH
  await tx(force.force(f.treasury.target));
  assert.equal(await f.balance(f.treasury.target), E('0.6'));
  assert.equal(await f.treasury.acquisitionBalance(), E('0.2'));
  assert.equal(await f.treasury.buybackBalance(), 0n);
  await tx(f.treasury.connect(f.attacker).accountSurplus());
  await tx(f.treasury.accountSurplus());
  await assertAccounting(f, E('0.6'), 0n);
  assert.equal(await f.treasury.totalFeesReceived(), E('0.2'));
  await assert.rejects(f.treasury.executeBuyback());
});

test('dishonest executor output reports revert ETH transfer, token delivery, burn, and cooldown together', async t => {
  const f = await fixture(t);
  await tx(f.executor.fee({ value: E('1') }));
  await f.list();
  await f.purchase();
  await tx(f.treasury.connect(f.buyer).buyNFT(1, f.addresses[2], { value: E('0.11') }));
  await tx(f.executor.configure(1000, 1, false));
  const supplyBefore = await f.token.totalSupply();
  const executorBefore = await f.token.balanceOf(f.executor.target);
  await assert.rejects(tx(f.treasury.connect(f.attacker).executeBuyback({ gasLimit: 1_000_000 })));
  await assertAccounting(f, E('0.9'), E('0.11'));
  assert.equal(await f.token.totalSupply(), supplyBefore);
  assert.equal(await f.token.balanceOf(f.executor.target), executorBefore);
  assert.equal(await f.balance(f.executor.target), 0n);
  assert.equal(await f.token.balanceOf(f.treasury.target), 0n);
  assert.equal(await f.treasury.totalBuybackSpent(), 0n);
  assert.equal(await f.treasury.totalTokensBurned(), 0n);
  assert.equal(await f.treasury.nextBuybackAt(), 0n);
  await tx(f.executor.configure(1000, 0, false));
  await tx(f.treasury.executeBuyback());
  await assertAccounting(f, E('0.9'), 0n);
});
