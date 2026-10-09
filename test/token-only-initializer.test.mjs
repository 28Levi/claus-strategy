import test from 'node:test';
import assert from 'node:assert/strict';
import { artifacts, deploy, deployHook, E, treasuryConfig, tx, v4Fixture, ZeroAddress } from './helper.mjs';

const INITIAL_SQRT_PRICE = 500265532822226746854230870154974n;

async function tokenOnlyFixture(t, initialize = true) {
  return v4Fixture(t, { mode: 'token-only', initialize });
}

test('token-only launch begins with zero native pool reserves, then buys and sells work with 2% fees', async t => {
  const f = await tokenOnlyFixture(t);
  assert.equal(await f.initializer.initialSqrtPriceX96(), INITIAL_SQRT_PRICE);
  assert.equal(await f.initializer.nativeDeposited(), 0n);
  assert.equal(await f.balance(f.initializer.target), 2n);
  assert.equal(await f.balance(f.manager.target), 0n);
  const tokens = await f.initializer.tokensDeposited();
  assert.ok(tokens * 100n >= f.supply * 99n);
  assert.equal(await f.token.balanceOf(f.manager.target), tokens);
  assert.equal(await f.token.balanceOf(f.initializer.target), f.supply - tokens);
  assert.equal(await f.token.balanceOf(f.addresses[0]), 0n);
  const reader = await deploy('InitializerPositionReader', f.admin);
  const liquidity = await f.initializer.lockedLiquidity();
  assert.ok(liquidity > 0n);
  assert.equal(await reader.tokenOnlyPositionLiquidity(f.manager.target, await f.hook.poolId(), f.initializer.target), liquidity);

  await f.swap(f.buyer, true, E('1'));
  const buyerAddress = await f.buyer.getAddress();
  const bought = await f.token.balanceOf(buyerAddress);
  assert.ok(bought > 0n);
  // First buy works without borrowing ETH from unrelated pools: the 2% fee is
  // backed by native claims after router settlement, then anyone can flush it.
  assert.equal(await f.hook.pendingFees(), E('0.02'));
  assert.equal(await f.manager.balanceOf(f.hook.target, 0), E('0.02'));
  assert.equal(await f.treasury.totalFeesReceived(), 0n);
  assert.equal(await f.balance(f.manager.target), E('1'));
  await tx(f.hook.connect(f.attacker).flushFees());
  assert.equal(await f.hook.pendingFees(), 0n);
  assert.equal(await f.treasury.totalFeesReceived(), E('0.02'));
  assert.equal(await f.balance(f.manager.target), E('0.98'));
  await f.swap(f.buyer, false, bought);
  assert.equal(await f.token.balanceOf(buyerAddress), 0n);
  assert.ok(await f.hook.pendingFees() > 0n);
  await tx(f.hook.connect(f.attacker).flushFees());
  assert.equal(await f.hook.pendingFees(), 0n);
  assert.equal(await f.manager.balanceOf(f.hook.target, 0), 0n);
  const grossNativeOut = E('0.98') - await f.balance(f.manager.target);
  assert.equal(await f.treasury.totalFeesReceived(), E('0.02') + grossNativeOut * 200n / 10_000n);
  // No base LP fee; round-trip leaves at most rounding dust in native reserves.
  assert.ok(await f.balance(f.manager.target) <= 2n);
  assert.equal(await reader.tokenOnlyPositionLiquidity(f.manager.target, await f.hook.poolId(), f.initializer.target), liquidity);
  assert.equal(await reader.tokenOnlyPositionLiquidity(f.manager.target, await f.hook.poolId(), f.addresses[0]), 0n);
});

test('token-only initial price and exact two-wei funding cannot be changed by the launcher', async t => {
  const f = await tokenOnlyFixture(t, false);
  for (const value of [0n, 1n, 3n, E('1')]) {
    await assert.rejects(f.initializer.initialize.staticCall(
      f.treasury.target, f.hook.target, INITIAL_SQRT_PRICE, { value }), /InvalidSeed/);
  }
  for (const price of [INITIAL_SQRT_PRICE - 1n, INITIAL_SQRT_PRICE + 1n, INITIAL_SQRT_PRICE / 2n]) {
    await assert.rejects(f.initializer.initialize.staticCall(
      f.treasury.target, f.hook.target, price, { value: 2n }), /InvalidInitialPrice/);
  }
  await assert.rejects(f.initializer.connect(f.attacker).initialize.staticCall(
    f.treasury.target, f.hook.target, INITIAL_SQRT_PRICE, { value: 2n }), /Unauthorized/);
  await assert.rejects(f.initializer.unlockCallback.staticCall('0x'), /UnexpectedCallback/);
  assert.equal(await f.initializer.initialized(), false);
  assert.equal(await f.treasury.hook(), ZeroAddress);
  await tx(f.initializer.initialize(f.treasury.target, f.hook.target, INITIAL_SQRT_PRICE, { value: 2n }));
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, f.hook.target, INITIAL_SQRT_PRICE, { value: 2n }), /AlreadyInitialized/);
  await assert.rejects(f.initializer.unlockCallback.staticCall('0x'), /UnexpectedCallback/);
});

test('token-only launches reject mismatched bindings and outside developer allocations', async t => {
  const f = await tokenOnlyFixture(t, false);
  const foreignHook = await deployHook(f.admin, [
    f.manager.target, f.token.target, f.treasury.target, f.addresses[0], 200, 1800, 500,
  ]);
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, foreignHook.target, INITIAL_SQRT_PRICE, { value: 2n }), /InvalidConfiguration/);
  const token = await deploy('StrategyToken', f.admin, ['Bad allocation', 'BAD', f.supply, f.addresses[0]]);
  const treasury = await deploy('StrategyTreasury', f.admin, [treasuryConfig({
    token: token.target, nft: f.nft.target, market: f.market.target, initializer: f.initializer.target,
  })]);
  const hook = await deployHook(f.admin, [f.manager.target, token.target, treasury.target, f.initializer.target, 200, 1800, 500]);
  await tx(token.transfer(f.initializer.target, f.supply - 1n));
  await assert.rejects(f.initializer.initialize.staticCall(
    treasury.target, hook.target, INITIAL_SQRT_PRICE, { value: 2n }), /InvalidSeed/);
  assert.equal(await f.initializer.initialized(), false);
  assert.equal(await treasury.hook(), ZeroAddress);
});

test('token-only initializer has no approval, withdrawal, or liquidity removal endpoint', async () => {
  const writes = artifacts.StrategyTokenOnlyInitializer.abi
    .filter(item => item.type === 'function' && !['view', 'pure'].includes(item.stateMutability))
    .map(item => item.name).sort();
  assert.deepEqual(writes, ['initialize', 'unlockCallback']);
  assert.equal(artifacts.StrategyTokenOnlyInitializer.abi.some(item => ['fallback', 'receive'].includes(item.type)), false);
});
