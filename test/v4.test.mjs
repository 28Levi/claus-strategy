import test from 'node:test';
import assert from 'node:assert/strict';
import { v4Fixture, chain, deploy, tx, E } from './helper.mjs';

test('real Uniswap v4 buys/sells deliver 2% native ETH fees; NFT sale buys and burns supply', async t => {
  const f = await v4Fixture(t);
  await f.swap(f.buyer, true, E('1'));
  assert.equal(await f.hook.pendingFees(), E('0.02'));
  assert.equal(await f.manager.balanceOf(f.hook.target, 0), E('0.02'));
  await assert.rejects(f.manager.connect(f.attacker).transferFrom(f.hook.target, f.addresses[3], 0, E('0.02')));
  await tx(f.hook.connect(f.attacker).flushFees());
  await tx(f.hook.connect(f.attacker).flushFees()); // empty flush cannot duplicate funding
  assert.equal(await f.treasury.totalFeesReceived(), E('0.02'));
  const bought = await f.token.balanceOf(f.addresses[2]);
  assert.ok(bought > 0n);
  const sellReceipt = await f.swap(f.buyer, false, bought / 2n);
  const feeEvent = sellReceipt.logs.map(l => { try { return f.hook.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === 'TradingFeeCollected');
  assert.equal(feeEvent.args.buy, false);
  assert.ok(feeEvent.args.amount > 0n);
  const poolSwap = sellReceipt.logs.map(l => { try { return f.manager.interface.parseLog(l); } catch { return null; } })
    .find(e => e?.name === 'Swap');
  assert.equal(feeEvent.args.amount, poolSwap.args.amount0 * 200n / 10_000n);
  await tx(f.hook.connect(f.attacker).flushFees());
  assert.equal(await f.treasury.totalFeesReceived(), E('0.02') + feeEvent.args.amount);
  assert.equal(await f.hook.pendingFees(), 0n);
  assert.equal(await f.manager.balanceOf(f.hook.target, 0), 0n);
  await tx(f.nft.mint(f.addresses[1], 1));
  await tx(f.nft.connect(f.seller).approve(f.market.target, 1));
  await tx(f.market.connect(f.seller).list(1, E('0.01')));
  const purchase = await tx(f.treasury.connect(f.attacker).purchaseCheapest(1, 1));
  assert.ok(purchase.gasUsed < 5_000_000n);
  assert.equal(await f.nft.ownerOf(1), f.treasury.target);
  await tx(f.treasury.connect(f.buyer).buyNFT(1, f.addresses[2], { value: E('0.011') }));
  await assert.rejects(f.treasury.executeBuyback()); // oracle must mature
  await f.time(1801);
  const minOut = await f.hook.minimumBuybackOut(E('0.011'));
  const supplyBefore = await f.token.totalSupply();
  const feeBefore = await f.treasury.totalFeesReceived();
  await tx(f.treasury.connect(f.attacker).executeBuyback());
  const burned = await f.treasury.totalTokensBurned();
  assert.ok(burned >= minOut);
  assert.equal(await f.token.totalSupply(), supplyBefore - burned);
  assert.equal(await f.token.balanceOf(f.treasury.target), 0n);
  assert.equal(await f.treasury.buybackBalance(), 0n);
  assert.equal(await f.treasury.totalFeesReceived(), feeBefore); // internal buyback not taxed recursively
  assert.equal(await f.balance(f.treasury.target), await f.treasury.acquisitionBalance());
  console.log(`Actual v4 cycle: purchase gas ${purchase.gasUsed}; burned ${burned} token wei; minimum ${minOut}.`);
});

test('real v4 hook rejects exact-output, fake callbacks and external buyback callers', async t => {
  const f = await v4Fixture(t);
  await assert.rejects(f.hook.executeBuyback({ value: E('0.01') }));
  await assert.rejects(f.hook.unlockCallback('0x'));
  await assert.rejects(f.hook.beforeSwap(f.addresses[0], f.key, [true, -E('1'), 4295128740n], '0x'));
  await assert.rejects(f.router.swap(f.key, [true, E('1'), 4295128740n], [false, false], '0x', { value: E('1') }));
  await assert.rejects(f.router.swap(f.key, [true, -E('1'), f.sqrtPriceX96 - 1n], [false, false], '0x', { value: E('1') }));
  assert.equal(await f.hook.pendingFees(), 0n); // partial fills also undo fee claims
  assert.equal(await f.treasury.totalFeesReceived(), 0n);
});

test('buyback rejects adverse spot movement against a mature historical TWAP', async t => {
  const f = await v4Fixture(t);
  await tx(f.admin.sendTransaction({ to: f.treasury.target, value: E('0.1') }));
  await tx(f.nft.mint(f.addresses[1], 1));
  await tx(f.nft.connect(f.seller).approve(f.market.target, 1));
  await tx(f.market.connect(f.seller).list(1, E('0.1')));
  await tx(f.treasury.purchaseCheapest(1, 1));
  await tx(f.treasury.buyNFT(1, f.addresses[0], { value: E('0.11') }));
  await f.time(1801);
  await f.swap(f.attacker, true, E('50')); // deplete token side relative to the historical quote
  await assert.rejects(f.treasury.executeBuyback());
  assert.equal(await f.treasury.buybackBalance(), E('0.11'));
  assert.equal(await f.treasury.totalTokensBurned(), 0n);
});

test('oracle honors elapsed ticks, rejects immature history and rounds negative means down', async t => {
  const c = await chain(t);
  const oracle = await deploy('OracleHarness', c.signers[0]);
  await assert.rejects(oracle.consult(1800));
  await tx(oracle.write(-101));
  await assert.rejects(oracle.consult(1800));
  const start = (await c.provider.getBlock('latest')).timestamp;
  await c.provider.send('evm_setNextBlockTimestamp', [start + 900]);
  await tx(oracle.write(-100));
  await c.provider.send('evm_setNextBlockTimestamp', [start + 1800]);
  await c.provider.send('evm_mine', []);
  assert.equal(await oracle.consult(1800), -101n);
  assert.equal(await oracle.quote(0, E('1')), E('1'));
  await assert.rejects(oracle.consult(60));
  await assert.rejects(oracle.write(887273));
});
