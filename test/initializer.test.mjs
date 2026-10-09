import test from 'node:test';
import assert from 'node:assert/strict';
import { artifacts, chain, deploy, deployHook, E, tx, v4Fixture, ZeroAddress } from './helper.mjs';

test('initializer locks the entire launch allocation in its own full-range PoolManager position', async t => {
  const f = await v4Fixture(t, { initialize: false });
  assert.equal(await f.initializer.initialized(), false);
  assert.equal(await f.token.balanceOf(f.initializer.target), f.supply);
  await tx(f.initializer.initialize(f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }));
  assert.equal(await f.initializer.initialized(), true);
  assert.equal(await f.treasury.hook(), f.hook.target);
  assert.equal(await f.initializer.token(), f.token.target);
  assert.equal(await f.initializer.poolManager(), f.manager.target);

  const native = await f.initializer.nativeDeposited();
  const tokens = await f.initializer.tokensDeposited();
  assert.ok(native * 100n >= f.seed * 99n && native <= f.seed);
  assert.ok(tokens * 100n >= f.supply * 99n && tokens <= f.supply);
  assert.equal(await f.balance(f.manager.target), native);
  assert.equal(await f.balance(f.initializer.target), f.seed - native);
  assert.equal(await f.token.balanceOf(f.manager.target), tokens);
  assert.equal(await f.token.balanceOf(f.initializer.target), f.supply - tokens);
  assert.equal(await f.token.balanceOf(f.addresses[0]), 0n);

  const reader = await deploy('InitializerPositionReader', f.admin);
  const liquidity = await f.initializer.lockedLiquidity();
  assert.ok(liquidity > 0n);
  assert.equal(await reader.positionLiquidity(f.manager.target, await f.hook.poolId(), f.initializer.target), liquidity);
  assert.equal(await reader.positionLiquidity(f.manager.target, await f.hook.poolId(), f.addresses[0]), 0n);

  // The initial liquidity remains owned by the immutable initializer after real swaps.
  await f.swap(f.buyer, true, E('1'));
  assert.equal(await reader.positionLiquidity(f.manager.target, await f.hook.poolId(), f.initializer.target), liquidity);
  assert.equal(await f.token.allowance(f.initializer.target, f.addresses[0]), 0n);
});

test('launch rejects unauthorized callers, missing seed, and repeated or unsolicited callbacks', async t => {
  const f = await v4Fixture(t, { initialize: false });
  await assert.rejects(f.initializer.connect(f.attacker).initialize.staticCall(
    f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }), /Unauthorized/);
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: E('0.99') }), /InvalidSeed/);
  await assert.rejects(f.initializer.unlockCallback.staticCall('0x'), /UnexpectedCallback/);
  await assert.rejects(f.manager.initialize.staticCall(f.key, f.sqrtPriceX96));
  assert.equal(await f.initializer.initialized(), false);
  assert.equal(await f.treasury.hook(), ZeroAddress);

  await tx(f.initializer.initialize(f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }));
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }), /AlreadyInitialized/);
  await assert.rejects(f.initializer.unlockCallback.staticCall('0x'), /UnexpectedCallback/);
});

test('a seed price that strands tokens or native funds reverts the entire launch', async t => {
  const f = await v4Fixture(t, { initialize: false });
  for (const sqrtPrice of [f.sqrtPriceX96 / 2n, f.sqrtPriceX96 * 2n]) {
    await assert.rejects(f.initializer.initialize.staticCall(
      f.treasury.target, f.hook.target, sqrtPrice, { value: f.seed }), /UnbalancedSeed/);
    await assert.rejects(tx(f.initializer.initialize(
      f.treasury.target, f.hook.target, sqrtPrice, { value: f.seed, gasLimit: 8_000_000 })));
    assert.equal(await f.initializer.initialized(), false);
    assert.equal(await f.treasury.hook(), ZeroAddress);
    assert.equal(await f.token.balanceOf(f.initializer.target), f.supply);
    assert.equal(await f.balance(f.initializer.target), 0n);
    assert.equal(await f.balance(f.manager.target), 0n);
  }
  // A failed attempt consumes neither the launch permission nor the asset allocation.
  await tx(f.initializer.initialize(f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }));
  assert.equal(await f.initializer.initialized(), true);
});

test('the initializer rejects a treasury whose hook authority is another account', async t => {
  const f = await v4Fixture(t, { initialize: false, config: { initializer: '0x1111111111111111111111111111111111111111' } });
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, f.hook.target, f.sqrtPriceX96, { value: f.seed }), /InvalidConfiguration/);
  assert.equal(await f.initializer.initialized(), false);
  assert.equal(await f.treasury.hook(), ZeroAddress);
});

test('the initializer rejects a hook with a different pool initializer', async t => {
  const f = await v4Fixture(t, { initialize: false });
  const foreignHook = await deployHook(f.admin, [
    f.manager.target, f.token.target, f.treasury.target, f.addresses[0], 200, 1800, 500,
  ]);
  await assert.rejects(f.initializer.initialize.staticCall(
    f.treasury.target, foreignHook.target, f.sqrtPriceX96, { value: f.seed }), /InvalidConfiguration/);
  assert.equal(await f.initializer.initialized(), false);
});

test('launch cannot leave a developer token allocation outside the locked pool', async t => {
  const f = await v4Fixture(t, { initialize: false });
  const token = await deploy('StrategyToken', f.admin, ['Invalid allocation', 'BAD', f.supply, f.addresses[0]]);
  const treasury = await deploy('StrategyTreasury', f.admin, [{ ...f.config, token: token.target }]);
  const hook = await deployHook(f.admin, [
    f.manager.target, token.target, treasury.target, f.initializer.target, 200, 1800, 500,
  ]);
  // Even 99.9% sent to the initializer cannot satisfy the whole-supply requirement.
  await tx(token.transfer(f.initializer.target, f.supply * 999n / 1000n));
  await assert.rejects(f.initializer.initialize.staticCall(
    treasury.target, hook.target, f.sqrtPriceX96, { value: f.seed }), /InvalidSeed/);
  assert.equal(await treasury.hook(), ZeroAddress);
  assert.equal(await f.initializer.initialized(), false);
});

test('initializer has only one launch entrypoint and authenticated callback, with no withdrawal surface', async t => {
  const mutating = artifacts.StrategyInitializer.abi
    .filter(item => item.type === 'function' && !['view', 'pure'].includes(item.stateMutability))
    .map(item => item.name).sort();
  assert.deepEqual(mutating, ['initialize', 'unlockCallback']);
  assert.equal(artifacts.StrategyInitializer.abi.some(item => ['fallback', 'receive'].includes(item.type)), false);

  const f = await chain(t);
  await assert.rejects(deploy('StrategyInitializer', f.signers[0], [ZeroAddress, 1n]));
  await assert.rejects(deploy('StrategyInitializer', f.signers[0], [f.addresses[0], 0n]));
  await assert.rejects(deploy('StrategyInitializer', f.signers[0], [f.addresses[0], 1n << 127n]));
});
