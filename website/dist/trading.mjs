import {
  AbiCoder, BrowserProvider, Contract, Interface, JsonRpcProvider, ZeroAddress,
  formatUnits, getAddress, keccak256, parseUnits,
} from './assets/ethers.min.js';

// This encoder is intentionally pinned to the deployed Universal Router v2
// interface, whose ExactInputSingleParams does not contain minHopPriceX36.
export const DEPENDENCIES = Object.freeze({
  router: Object.freeze({ address: '0x66a9893cc07d91d95644aedd05d03f95e1dba8af', runtimeCodeHash: '0x6a5f46971b50c6e1b7eef97902311444e479d734e4f80ad88367783cf373fe7f' }),
  quoter: Object.freeze({ address: '0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203', runtimeCodeHash: '0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441' }),
  permit2: Object.freeze({ address: '0x000000000022D473030F116dDEE9F6B43aC78BA3', runtimeCodeHash: '0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131' }),
  poolManager: Object.freeze({ address: '0x000000000004444c5dc75cB358380D2e3dE08A90', runtimeCodeHash: '0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293' }),
});
export const POOL_KEY_TYPE = 'tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)';
export const ROUTER_ABI = ['function execute(bytes commands,bytes[] inputs,uint256 deadline) payable', 'function poolManager() view returns (address)'];
export const QUOTER_ABI = [`function quoteExactInputSingle(tuple(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`, 'function poolManager() view returns (address)'];
export const PERMIT2_ABI = ['function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)', 'function approve(address token,address spender,uint160 amount,uint48 expiration)'];
const TOKEN_ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)'];
const HOOK_ABI = ['function token() view returns (address)', 'function treasury() view returns (address)', 'function poolManager() view returns (address)', 'function poolInitializer() view returns (address)', 'function feeBps() view returns (uint16)', 'function poolId() view returns (bytes32)'];
const TREASURY_ABI = ['function token() view returns (address)', 'function hook() view returns (address)', 'function initializer() view returns (address)'];
const INITIALIZER_ABI = ['function initialized() view returns (bool)', 'function token() view returns (address)', 'function hook() view returns (address)', 'function treasury() view returns (address)', 'function poolManager() view returns (address)', 'function lockedLiquidity() view returns (uint128)'];
const abi = AbiCoder.defaultAbiCoder();
const routerInterface = new Interface(ROUTER_ABI);
const MAX_INPUT = (1n << 127n) - 1n;
const MAX_OUTPUT = (1n << 128n) - 1n;
const sameAddress = (a, b) => getAddress(a) === getAddress(b);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

export function assertLiveConfig(config) {
  requireCondition(config?.status === 'live', 'Trading opens after the verified Ethereum launch.');
  requireCondition(config.chainId === 1, 'This trading route supports Ethereum mainnet only.');
  for (const role of ['token', 'hook', 'treasury', 'initializer', 'poolManager']) {
    const entry = config.contracts?.[role];
    requireCondition(entry && sameAddress(entry.address, entry.address) && entry.address !== ZeroAddress
      && /^0x[0-9a-f]{64}$/i.test(entry.runtimeCodeHash), `Missing verified ${role} deployment.`);
  }
  requireCondition(new Set(['token', 'hook', 'treasury', 'initializer', 'poolManager'].map(role => config.contracts[role].address.toLowerCase())).size === 5, 'Deployment roles must be distinct.');
  requireCondition(sameAddress(config.contracts.poolManager.address, DEPENDENCIES.poolManager.address)
    && config.contracts.poolManager.runtimeCodeHash.toLowerCase() === DEPENDENCIES.poolManager.runtimeCodeHash, 'Unexpected PoolManager deployment.');
  for (const role of ['router', 'quoter', 'permit2']) {
    const entry = config.trading?.dependencies?.[role];
    const pin = DEPENDENCIES[role];
    requireCondition(entry && sameAddress(entry.address, pin.address)
      && entry.runtimeCodeHash.toLowerCase() === pin.runtimeCodeHash, `Unexpected ${role} deployment.`);
  }
  requireCondition((BigInt(config.contracts.hook.address) & 0x3fffn) === 0x30ccn, 'Unexpected strategy hook permissions.');
  return config;
}

export function poolKey(config) {
  return [ZeroAddress, getAddress(config.contracts.token.address), 0, 60, getAddress(config.contracts.hook.address)];
}

export function configurationId(config) {
  assertLiveConfig(config);
  return keccak256(abi.encode(['address[]', 'bytes32[]'], [
    ['token', 'hook', 'treasury', 'initializer', 'poolManager'].map(k => config.contracts[k].address),
    ['token', 'hook', 'treasury', 'initializer', 'poolManager'].map(k => config.contracts[k].runtimeCodeHash),
  ]));
}

export async function verifyTradingDeployment(config, provider) {
  assertLiveConfig(config);
  // Query the endpoint as well as ethers' network object: a JsonRpcProvider may
  // be configured with staticNetwork, which otherwise only repeats that option.
  const [network, reportedChain] = await Promise.all([provider.getNetwork(), provider.send('eth_chainId', [])]);
  requireCondition(network.chainId === 1n && BigInt(reportedChain) === 1n, 'Switch your wallet to Ethereum mainnet.');
  const entries = { ...config.contracts, ...config.trading.dependencies };
  await Promise.all(Object.entries(entries).map(async ([role, entry]) => {
    requireCondition(entry && /^0x[0-9a-f]{64}$/i.test(entry.runtimeCodeHash), `Missing verified ${role} code hash.`);
    const code = await provider.getCode(entry.address);
    requireCondition(code !== '0x' && keccak256(code).toLowerCase() === entry.runtimeCodeHash.toLowerCase(), `${role} contract code does not match the verified deployment.`);
  }));
  const c = config.contracts;
  const hook = new Contract(c.hook.address, HOOK_ABI, provider);
  const treasury = new Contract(c.treasury.address, TREASURY_ABI, provider);
  const initializer = new Contract(c.initializer.address, INITIALIZER_ABI, provider);
  const checks = [
    [hook.token(), c.token.address], [hook.treasury(), c.treasury.address],
    [hook.poolManager(), c.poolManager.address], [hook.poolInitializer(), c.initializer.address],
    [treasury.token(), c.token.address], [treasury.hook(), c.hook.address], [treasury.initializer(), c.initializer.address],
    [initializer.token(), c.token.address], [initializer.hook(), c.hook.address],
    [initializer.treasury(), c.treasury.address], [initializer.poolManager(), c.poolManager.address],
    [new Contract(DEPENDENCIES.router.address, ROUTER_ABI, provider).poolManager(), c.poolManager.address],
    [new Contract(DEPENDENCIES.quoter.address, QUOTER_ABI, provider).poolManager(), c.poolManager.address],
  ];
  await Promise.all(checks.map(async ([value, expected]) => requireCondition(sameAddress(await value, expected), 'The deployed contract bindings do not match this strategy.')));
  const [initialized, liquidity, decimals, fee, id] = await Promise.all([
    initializer.initialized(), initializer.lockedLiquidity(), new Contract(c.token.address, TOKEN_ABI, provider).decimals(), hook.feeBps(), hook.poolId(),
  ]);
  requireCondition(initialized && liquidity > 0n, 'The strategy pool has not been initialized.');
  requireCondition(decimals === 18n && fee === 200n, 'The token decimals or strategy fee differs from the published launch.');
  requireCondition(id === keccak256(abi.encode([POOL_KEY_TYPE], [poolKey(config)])), 'The pool ID does not match this strategy.');
  return { poolId: id, configurationId: configurationId(config) };
}

function parseAmount(amount) {
  requireCondition(typeof amount === 'string' && /^\d+(?:\.\d{1,18})?$/.test(amount), 'Enter a positive amount with at most 18 decimal places.');
  const value = parseUnits(amount, 18);
  requireCondition(value > 0n && value <= MAX_INPUT, 'Trade amount is outside the supported range.');
  return value;
}

export async function quoteTrade({ config, direction, amount, slippageBps = 100, provider: suppliedProvider }) {
  assertLiveConfig(config);
  requireCondition(direction === 'buy' || direction === 'sell', 'Choose buy or sell.');
  requireCondition(Number.isInteger(slippageBps) && slippageBps >= 0 && slippageBps <= 500, 'Slippage must be between 0% and 5%.');
  const amountIn = parseAmount(amount);
  if (!suppliedProvider) requireCondition(typeof config.rpcUrl === 'string' && /^https:\/\//.test(config.rpcUrl), 'A secure Ethereum RPC endpoint is required.');
  const provider = suppliedProvider ?? new JsonRpcProvider(config.rpcUrl, 1, { staticNetwork: true });
  try {
    const binding = await verifyTradingDeployment(config, provider);
    const block = await provider.getBlock('latest');
    const [amountOut, gasEstimate] = await new Contract(DEPENDENCIES.quoter.address, QUOTER_ABI, provider)
      .quoteExactInputSingle.staticCall([poolKey(config), direction === 'buy', amountIn, '0x']);
    requireCondition(amountOut > 0n && amountOut <= MAX_OUTPUT, 'No usable liquidity quote is available.');
    const minOut = amountOut * BigInt(10_000 - slippageBps) / 10_000n;
    requireCondition(minOut > 0n, 'The minimum received amount would round to zero.');
    return {
      ...binding, chainId: 1, direction, amountInWei: amountIn.toString(), amountOutWei: amountOut.toString(),
      minOutWei: minOut.toString(), slippageBps, deadline: block.timestamp + 600,
      quotedAtBlock: block.number, amountOut: formatUnits(amountOut, 18), minimumReceived: formatUnits(minOut, 18),
      gasEstimate: gasEstimate.toString(), feeBps: 200,
    };
  } finally { if (!suppliedProvider) provider.destroy(); }
}

export function encodeTrade(config, quote) {
  assertLiveConfig(config);
  requireCondition(quote?.configurationId === configurationId(config) && quote.chainId === 1, 'This quote belongs to another deployment.');
  requireCondition(quote.direction === 'buy' || quote.direction === 'sell', 'Invalid trade direction.');
  const amountIn = BigInt(quote.amountInWei), amountOut = BigInt(quote.amountOutWei), minOut = BigInt(quote.minOutWei);
  requireCondition(amountIn > 0n && amountIn <= MAX_INPUT && amountOut > 0n && amountOut <= MAX_OUTPUT && minOut > 0n, 'Invalid trade amounts.');
  requireCondition(Number.isInteger(quote.slippageBps) && quote.slippageBps >= 0 && quote.slippageBps <= 500
    && minOut === amountOut * BigInt(10_000 - quote.slippageBps) / 10_000n, 'Quote minimum received is inconsistent.');
  requireCondition(Number.isSafeInteger(quote.deadline) && quote.deadline > 0, 'Invalid quote deadline.');
  const buy = quote.direction === 'buy';
  const input = buy ? ZeroAddress : config.contracts.token.address;
  const output = buy ? config.contracts.token.address : ZeroAddress;
  const parameters = [
    abi.encode([`tuple(${POOL_KEY_TYPE} poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)`], [[poolKey(config), buy, amountIn, minOut, '0x']]),
    // Settle the exact input. Any incomplete fill leaves a currency delta and
    // causes PoolManager to revert the entire trade instead of silently filling part.
    abi.encode(['address', 'uint256', 'bool'], [input, amountIn, true]),
    abi.encode(['address', 'uint256'], [output, minOut]),
  ];
  const inputs = [abi.encode(['bytes', 'bytes[]'], ['0x060b0f', parameters])];
  return { to: getAddress(DEPENDENCIES.router.address), data: routerInterface.encodeFunctionData('execute', ['0x10', inputs, quote.deadline]), value: buy ? amountIn : 0n };
}

export async function executeTrade({ config, ethereum, quote, onStatus = () => {} }) {
  assertLiveConfig(config);
  requireCondition(ethereum?.request, 'Connect an Ethereum wallet to continue.');
  const request = encodeTrade(config, quote);
  const provider = new BrowserProvider(ethereum, undefined, { cacheTimeout: -1 });
  try {
    const binding = await verifyTradingDeployment(config, provider);
    requireCondition(binding.poolId === quote.poolId, 'This quote belongs to another pool.');
    const checkDeadline = async () => {
      const block = await provider.getBlock('latest');
      requireCondition(block.timestamp < quote.deadline && quote.deadline <= block.timestamp + 600, 'This quote expired. Request a new quote.');
    };
    await checkDeadline();
    await ethereum.request({ method: 'eth_requestAccounts' });
    const signer = await provider.getSigner();
    const owner = await signer.getAddress();
    if (quote.direction === 'sell') {
      const token = new Contract(config.contracts.token.address, TOKEN_ABI, signer);
      const amountIn = BigInt(quote.amountInWei);
      requireCondition(await token.balanceOf(owner) >= amountIn, 'Your wallet does not hold enough strategy tokens.');
      if (await token.allowance(owner, DEPENDENCIES.permit2.address) !== amountIn) {
        onStatus('Approve only this sale amount for Permit2 in your wallet.');
        await (await token.approve(DEPENDENCIES.permit2.address, amountIn)).wait();
      }
      await checkDeadline();
      const permit2 = new Contract(DEPENDENCIES.permit2.address, PERMIT2_ABI, signer);
      const allowance = await permit2.allowance(owner, token.target, DEPENDENCIES.router.address);
      if (allowance.amount !== amountIn || allowance.expiration !== BigInt(quote.deadline)) {
        onStatus('Authorize the router for this sale amount until this quote expires.');
        await (await permit2.approve(token.target, DEPENDENCIES.router.address, amountIn, quote.deadline)).wait();
      }
    }
    await checkDeadline();
    // Simulate after approvals using the actual connected account, same minimum
    // output and deadline. Wallet confirmation still authorizes every transaction.
    await provider.call({ ...request, from: owner });
    onStatus('Confirm the swap in your wallet.');
    const response = await signer.sendTransaction(request);
    onStatus('Swap submitted. Waiting for Ethereum confirmation.');
    const receipt = await response.wait();
    requireCondition(receipt?.status === 1, 'The swap did not succeed.');
    onStatus('Swap confirmed.');
    return { hash: response.hash, receipt };
  } finally { provider.destroy(); }
}
