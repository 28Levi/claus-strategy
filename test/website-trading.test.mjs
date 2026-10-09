import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { AbiCoder, Interface, ZeroAddress, keccak256 } from 'ethers';
import { assertLiveConfig, configurationId, encodeTrade, executeTrade, poolKey, quoteTrade, verifyTradingDeployment, DEPENDENCIES, POOL_KEY_TYPE, ROUTER_ABI } from '../website/dist/trading.mjs';

const hash = `0x${'11'.repeat(32)}`;
function config() {
  return { status: 'live', chainId: 1, contracts: {
    token: { address: '0x0000000000000000000000000000000000000001', runtimeCodeHash: hash },
    hook: { address: '0x00000000000000000000000000000000000130cc', runtimeCodeHash: hash },
    treasury: { address: '0x0000000000000000000000000000000000000003', runtimeCodeHash: hash },
    initializer: { address: '0x0000000000000000000000000000000000000004', runtimeCodeHash: hash },
    poolManager: { ...DEPENDENCIES.poolManager },
  }, trading: { dependencies: Object.fromEntries(['router', 'quoter', 'permit2'].map(k => [k, { ...DEPENDENCIES[k] }])) } };
}
function quote(c, direction) {
  return { configurationId: configurationId(c), poolId: keccak256(AbiCoder.defaultAbiCoder().encode([POOL_KEY_TYPE], [poolKey(c)])),
    chainId: 1, direction, amountInWei: '1000', amountOutWei: '2000', minOutWei: '1980', slippageBps: 100, deadline: 2000000000 };
}

test('website cannot quote or request wallet access before the verified launch', async () => {
  let touched = false;
  const ethereum = { request: async () => { touched = true; throw new Error('unexpected wallet request'); } };
  await assert.rejects(quoteTrade({ config: { status: 'prelaunch' }, direction: 'buy', amount: '1' }), /verified Ethereum launch/);
  await assert.rejects(executeTrade({ config: { status: 'prelaunch' }, ethereum, quote: {} }), /verified Ethereum launch/);
  assert.equal(touched, false);
});

test('website encoder sends fixed v4 pool exact input, exact settlement, protected output, and a deadline', () => {
  for (const direction of ['buy', 'sell']) {
    const c = config(), q = quote(c, direction), encoded = encodeTrade(c, q);
    const decoded = new Interface(ROUTER_ABI).decodeFunctionData('execute', encoded.data);
    assert.equal(encoded.to.toLowerCase(), DEPENDENCIES.router.address);
    assert.equal(encoded.value, direction === 'buy' ? 1000n : 0n);
    assert.equal(decoded.commands, '0x10');
    assert.equal(decoded.deadline, BigInt(q.deadline));
    const abi = AbiCoder.defaultAbiCoder();
    const [actions, params] = abi.decode(['bytes', 'bytes[]'], decoded.inputs[0]);
    assert.equal(actions, '0x060b0f');
    const [swap] = abi.decode([`tuple(${POOL_KEY_TYPE},bool,uint128,uint128,bytes)`], params[0]);
    assert.equal(swap[0][0], ZeroAddress);
    assert.equal(swap[0][1], c.contracts.token.address);
    assert.equal(swap[0][2], 0n);
    assert.equal(swap[0][3], 60n);
    assert.equal(swap[0][4].toLowerCase(), c.contracts.hook.address);
    assert.equal(swap[1], direction === 'buy');
    assert.equal(swap[2], 1000n);
    assert.equal(swap[3], 1980n);
    assert.equal(swap[4], '0x');
    const settle = abi.decode(['address', 'uint256', 'bool'], params[1]);
    assert.equal(settle[0], direction === 'buy' ? ZeroAddress : c.contracts.token.address);
    assert.equal(settle[1], 1000n);
    assert.equal(settle[2], true);
    const take = abi.decode(['address', 'uint256'], params[2]);
    assert.equal(take[0], direction === 'buy' ? c.contracts.token.address : ZeroAddress);
    assert.equal(take[1], 1980n);
  }
});

test('website rejects unpinned dependencies, different deployments, and zero or weakened output limits', () => {
  const c = config(), q = quote(c, 'buy');
  const unpinned = config(); unpinned.trading.dependencies.router.address = unpinned.contracts.token.address;
  assert.throws(() => assertLiveConfig(unpinned), /Unexpected router/);
  const changed = config(); changed.contracts.token.runtimeCodeHash = `0x${'22'.repeat(32)}`;
  assert.throws(() => encodeTrade(changed, q), /another deployment/);
  assert.throws(() => encodeTrade(c, { ...q, minOutWei: '0' }), /Invalid trade amounts/);
  assert.throws(() => encodeTrade(c, { ...q, minOutWei: '1' }), /inconsistent/);
  assert.throws(() => encodeTrade(c, { ...q, slippageBps: 10_000 }), /inconsistent/);
  assert.throws(() => encodeTrade(c, { ...q, amountInWei: ((1n << 127n) + 1n).toString() }), /Invalid trade amounts/);
});

test('website rejects malformed amounts and unsafe slippage before contacting a provider', async () => {
  const c = config();
  for (const amount of ['0', '-1', '1e6', '0.0000000000000000001', 'NaN', ' 1']) {
    await assert.rejects(quoteTrade({ config: c, amount, direction: 'buy' }), /amount|range/);
  }
  await assert.rejects(quoteTrade({ config: c, amount: '1', direction: 'buy', slippageBps: 501 }), /Slippage/);
});

test('website checks the RPC chain ID even when ethers is configured with a static network', async () => {
  const provider = { getNetwork: async () => ({ chainId: 1n }), send: async () => '0x7a69' };
  await assert.rejects(verifyTradingDeployment(config(), provider), /Ethereum mainnet/);
});

test('browser dependency pins match the recorded canonical release', () => {
  const release = JSON.parse(readFileSync(new URL('../config/uniswap.ethereum-release.json', import.meta.url), 'utf8'));
  assert.deepEqual(DEPENDENCIES, release.dependencies);
});
