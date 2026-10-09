import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deploy, tx, E, ZeroAddress, artifacts } from './helper.mjs';

test('fees buy cheapest Claus listing, lock custody, sell at 1.1x and burn actual supply', async t => {
  const f = await fixture(t);
  await f.list(1, E('0.2'));
  await f.list(2, E('0.1'));
  await tx(f.executor.fee({ value: E('0.3') }));
  assert.equal(await f.treasury.totalFeesReceived(), E('0.3'));
  assert.equal((await f.treasury.cheapestListing()).tokenId, 2n);
  await assert.rejects(f.purchase(1));
  await f.purchase(2);
  assert.equal(await f.nft.ownerOf(2), f.treasury.target);
  assert.equal(await f.nft.getApproved(2), ZeroAddress);
  assert.equal(await f.nft.isApprovedForAll(f.treasury.target, f.market.target), false);
  assert.equal((await f.treasury.positions(2)).ask, E('0.11'));
  assert.equal(await f.treasury.acquisitionBalance(), E('0.2'));
  await assert.rejects(f.nft.transferFrom(f.treasury.target, f.addresses[0], 2));
  await assert.rejects(f.nft.approve(f.addresses[0], 2));
  await tx(f.treasury.connect(f.buyer).buyNFT(2, f.addresses[2], { value: E('0.11') }));
  assert.equal(await f.nft.ownerOf(2), f.addresses[2]);
  assert.equal(await f.treasury.buybackBalance(), E('0.11'));
  const supply = await f.token.totalSupply();
  await tx(f.treasury.connect(f.attacker).executeBuyback());
  assert.equal(await f.token.totalSupply(), supply - E('110'));
  assert.equal(await f.treasury.totalTokensBurned(), E('110'));
  assert.equal(await f.treasury.buybackBalance(), 0n);
  assert.equal(await f.treasury.acquisitionBalance(), E('0.2'));
  assert.equal(await f.balance(f.treasury.target), E('0.2'));
});

test('zero/under/overpayments and invalid recipients cannot release treasury NFTs', async t => {
  const f = await fixture(t);
  await f.list(1, 11n);
  await tx(f.executor.fee({ value: 11n }));
  await f.purchase();
  assert.equal((await f.treasury.positions(1)).ask, 13n);
  for (const value of [0n, 12n, 14n]) await assert.rejects(f.treasury.buyNFT(1, f.addresses[0], { value }));
  for (const recipient of [ZeroAddress, f.treasury.target]) await assert.rejects(f.treasury.buyNFT(1, recipient, { value: 13n }));
  await assert.rejects(f.treasury.buyNFT(2, f.addresses[0], { value: 13n }));
  assert.equal(await f.nft.ownerOf(1), f.treasury.target);
  assert.equal(await f.treasury.buybackBalance(), 0n);
});

test('fixed price cap, per-epoch spending, cooldown and inventory bounds constrain everyone', async t => {
  const f = await fixture(t, { config: { maxPurchasePrice: E('0.1'), maxSpendPerEpoch: E('0.15'), maxInventory: 2 } });
  await f.list(1, E('0.1'));
  await f.list(2, E('0.1'));
  await f.list(3, E('0.2'));
  await tx(f.executor.fee({ value: E('1') }));
  await f.purchase();
  await assert.rejects(f.purchase(2));
  await f.time(61);
  await assert.rejects(f.purchase(2)); // daily budget, not just cooldown
  await f.time(86401);
  await f.purchase(2);
  assert.equal((await f.treasury.cheapestListing()).found, false); // third listing over cap
  await f.list(4, E('0.05'));
  await f.time(86401);
  await assert.rejects(f.purchase(4)); // inventory bound
  assert.equal(await f.treasury.inventoryCount(), 2n);
});

test('stale market revision, withdrawn approval and transfer nonce cannot be bypassed', async t => {
  const f = await fixture(t);
  await f.list();
  await tx(f.executor.fee({ value: E('1') }));
  await tx(f.market.connect(f.seller).list(1, E('0.11')));
  await assert.rejects(f.treasury.purchaseCheapest(1, 1));
  await tx(f.nft.connect(f.seller).approve(ZeroAddress, 1));
  assert.equal((await f.treasury.cheapestListing()).found, false);
  await tx(f.nft.connect(f.seller).approve(f.market.target, 1));
  await tx(f.nft.connect(f.seller).transferFrom(f.addresses[1], f.addresses[2], 1));
  await tx(f.nft.connect(f.buyer).transferFrom(f.addresses[2], f.addresses[1], 1));
  await tx(f.nft.connect(f.seller).approve(f.market.target, 1));
  assert.equal((await f.treasury.cheapestListing()).found, false);
});

test('failed and dishonest buybacks roll back ETH, balances and cooldown', async t => {
  const f = await fixture(t);
  await f.list();
  await tx(f.executor.fee({ value: E('0.1') }));
  await f.purchase();
  await tx(f.treasury.buyNFT(1, f.addresses[0], { value: E('0.11') }));
  for (const args of [[1000, 1, false], [1000, 0, true], [0, 0, false]]) {
    await tx(f.executor.configure(...args));
    await assert.rejects(f.treasury.executeBuyback());
    assert.equal(await f.treasury.buybackBalance(), E('0.11'));
    assert.equal(await f.balance(f.treasury.target), E('0.11'));
    assert.equal(await f.treasury.nextBuybackAt(), 0n);
  }
});

test('buybacks spend only resale reserve and enforce batch limit plus cooldown', async t => {
  const f = await fixture(t, { config: { maxBuybackAmount: E('0.05') } });
  await f.list();
  await tx(f.executor.fee({ value: E('1') }));
  await assert.rejects(f.treasury.executeBuyback());
  await f.purchase();
  await tx(f.treasury.buyNFT(1, f.addresses[0], { value: E('0.11') }));
  await tx(f.treasury.executeBuyback());
  assert.equal(await f.treasury.buybackBalance(), E('0.06'));
  assert.equal(await f.treasury.acquisitionBalance(), E('0.9'));
  await assert.rejects(f.treasury.executeBuyback());
  await f.time(61);
  await tx(f.treasury.executeBuyback());
  await f.time(61);
  await tx(f.treasury.executeBuyback());
  assert.equal(await f.treasury.buybackBalance(), 0n);
  assert.equal(await f.treasury.totalBuybackSpent(), E('0.11'));
});

test('holding rewards, donations and forced ETH cannot become withdrawable credits', async t => {
  const f = await fixture(t);
  await tx(f.admin.sendTransaction({ to: f.treasury.target, value: E('0.03'), gasLimit: 60000 }));
  const force = await deploy('ForceETH', f.admin, [{ value: E('0.02') }]);
  await tx(force.force(f.treasury.target));
  assert.equal(await f.treasury.acquisitionBalance(), E('0.03'));
  await tx(f.treasury.connect(f.attacker).accountSurplus());
  assert.equal(await f.treasury.acquisitionBalance(), E('0.05'));
  assert.equal(await f.treasury.totalFeesReceived(), 0n);
  await assert.rejects(f.treasury.connect(f.attacker).recordFees({ value: 1n }));
});

test('unsolicited safe NFT transfers rejected; no privileged custody or token controls in ABI', async t => {
  const f = await fixture(t);
  await tx(f.nft.mint(f.addresses[0], 9));
  await assert.rejects(f.nft['safeTransferFrom(address,address,uint256)'](f.addresses[0], f.treasury.target, 9));
  for (const name of ['StrategyTreasury', 'StrategyToken', 'StrategyV4Hook', 'StrategyInitializer']) {
    const functions = artifacts[name].abi.filter(a => a.type === 'function').map(a => a.name);
    for (const forbidden of ['withdraw', 'withdrawNFT', 'redeem', 'upgradeTo', 'upgradeToAndCall', 'setFee', 'mint', 'execute', 'approveNFT', 'setApprovalForAll', 'transferOwnership']) {
      assert.equal(functions.includes(forbidden), false, `${name}.${forbidden}`);
    }
  }
});

test('same treasury policy supports other ERC721 collections through the reusable offer market', async t => {
  const f = await fixture(t, { market: 'generic' });
  await f.list(1, E('0.1'));
  assert.equal(await f.nft.ownerOf(1), f.market.target);
  await assert.rejects(f.market.cancel(1));
  await tx(f.executor.fee({ value: E('0.1') }));
  await f.purchase();
  assert.equal(await f.nft.ownerOf(1), f.treasury.target);
  assert.equal(await f.market.proceeds(f.addresses[1]), E('0.1'));
  await tx(f.market.connect(f.seller).withdrawProceeds(f.addresses[1]));
  assert.equal(await f.market.proceeds(f.addresses[1]), 0n);
});
