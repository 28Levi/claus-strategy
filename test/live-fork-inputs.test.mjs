import test from 'node:test';
import assert from 'node:assert/strict';
import { parseForkArgs, readEthereumPin, requireForkEnvironment } from '../scripts/verify-opensea-fork.mjs';

const hash = `0x${'ab'.repeat(32)}`;
const pin = { blockNumber: 26154629, blockHash: hash };

test('live fork verifier requires an explicit pin and environment credentials', () => {
  assert.deepEqual(parseForkArgs(['--hash', hash, '--block', '26154629']), pin);
  assert.deepEqual(parseForkArgs(['--capture-pin']), { capturePin: true });
  assert.equal(parseForkArgs(['--block', '26154629', '--hash', hash, '--require-restricted']).requireRestricted, true);
  for (const args of [[], ['--block','1'], ['--hash',hash], ['--block','0','--hash',hash], ['--block','1','--hash','0x1234'], ['--block','1','--hash',hash,'--block','2'], ['--capture-pin','--block','1'], ['--api-key','secret']]) {
    assert.throws(() => parseForkArgs(args));
  }
  assert.throws(() => requireForkEnvironment(pin, {}), /CLAUS_FORK_RPC/);
  assert.throws(() => requireForkEnvironment(pin, { CLAUS_FORK_RPC: 'https://rpc.example' }), /OPENSEA_API_KEY/);
  assert.throws(() => requireForkEnvironment(pin, { CLAUS_FORK_RPC: 'http://remote.example', OPENSEA_API_KEY: 'test' }), /HTTPS/);
  assert.throws(() => requireForkEnvironment(pin, { CLAUS_FORK_RPC: 'https://rpc.example', OPENSEA_API_KEY: 'test\n' }), /OPENSEA_API_KEY/);
  assert.deepEqual(requireForkEnvironment({ capturePin: true }, { CLAUS_FORK_RPC: 'https://rpc.example' }), { rpc: 'https://rpc.example', apiKey: undefined });
});

test('live fork pin reader makes only chain/header reads and rejects a changed block or chain', async () => {
  const calls = [];
  const fake = (chainId = '0x1', blockHash = hash) => async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    assert.equal(options.redirect, 'error');
    assert.ok(['eth_chainId', 'eth_getBlockByNumber'].includes(request.method));
    return { ok: true, json: async () => ({ result: request.method === 'eth_chainId' ? chainId : { number: '0x18f1685', hash: blockHash } }) };
  };
  assert.deepEqual(await readEthereumPin('https://rpc.example', pin, fake()), pin);
  assert.deepEqual(calls.map(call => call.method), ['eth_chainId','eth_getBlockByNumber']);
  assert.equal(calls[1].params[0], '0x18f1685');
  await assert.rejects(readEthereumPin('https://rpc.example', pin, fake('0x89')), /mainnet/);
  await assert.rejects(readEthereumPin('https://rpc.example', pin, fake('0x1', `0x${'cd'.repeat(32)}`)), /hash differs/);
});
