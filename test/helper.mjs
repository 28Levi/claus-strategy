import fs from 'node:fs';
import path from 'node:path';
import hre from 'hardhat';
import { BrowserProvider, ContractFactory, Contract, parseEther, getCreate2Address, keccak256, toBeHex, ZeroAddress } from 'ethers';
import { compile, ROOT } from '../scripts/compile.mjs';
import { compileSeaport } from '../scripts/compile-seaport.mjs';

export const E = parseEther;
export { ZeroAddress };
const directory = path.join(ROOT, 'artifacts');
// Rebuild when a source or the compiler settings changed; never test stale bytecode.
function cachedArtifacts() {
  const inputPath = path.join(directory, 'standard-input.json');
  const solFiles = dir => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? solFiles(path.join(dir, e.name)) : e.name.endsWith('.sol') ? [path.join(dir, e.name)] : []) : [];
  try {
    const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const own = [...solFiles(path.join(ROOT, 'contracts')), ...solFiles(path.join(ROOT, 'test/contracts'))];
    const recorded = Object.keys(input.sources).filter(s => s.startsWith('contracts/') || s.startsWith('test/contracts/'));
    if (own.length !== recorded.length || own.some(file =>
      input.sources[path.relative(ROOT, file).replaceAll('\\', '/')]?.content !== fs.readFileSync(file, 'utf8'))
      || fs.statSync(inputPath).mtimeMs < fs.statSync(path.join(ROOT, 'scripts/compile.mjs')).mtimeMs) throw new Error('stale');
    const output = JSON.parse(fs.readFileSync(path.join(directory, 'standard-output.json'), 'utf8'));
    const entries = Object.values(output.contracts).flatMap(c => Object.keys(c));
    return Object.fromEntries(entries.map(name => [name, JSON.parse(fs.readFileSync(path.join(directory, `${name}.json`), 'utf8'))]));
  } catch { return compile({ write: true }).artifacts; }
}
export const artifacts = { ...cachedArtifacts(), ...compileSeaport() };

export async function chain(t) {
  const connection = await hre.network.create('hardhatMainnet');
  const provider = new BrowserProvider(connection.provider, undefined, { cacheTimeout: -1 });
  provider.pollingInterval = 10;
  const signers = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const close = async () => { provider.destroy(); await connection.close(); };
  if (t) t.after(close);
  return { connection, provider, signers, addresses, close,
    async time(seconds) { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); },
    async balance(address) { return BigInt(await provider.send('eth_getBalance', [address, 'latest'])); },
  };
}

export async function deploy(name, signer, args = []) {
  const a = artifacts[name];
  if (!a) throw new Error(`Missing artifact ${name}`);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

export async function tx(promise) { return (await promise).wait(); }

export function treasuryConfig({ token, nft, market, initializer, ...overrides }) {
  return {
    token, collection: nft, market, initializer,
    firstTokenId: 1, tokenCount: 300, maxPurchasePrice: E('1'), maxSpendPerEpoch: E('2'),
    epochDuration: 86400, minPurchaseInterval: 60, maxInventory: 5,
    maxBuybackAmount: E('0.2'), minBuybackInterval: 60, ...overrides,
  };
}

export async function fixture(t, options = {}) {
  const c = await chain(t);
  const [admin, seller, buyer, attacker] = c.signers;
  const nft = await deploy('MockNFT', admin);
  const token = await deploy('StrategyToken', admin, ['Claus Strategy', 'CLSTR', E('1000000000'), c.addresses[0]]);
  const nativeMarket = options.market !== 'generic';
  const market = await deploy(nativeMarket ? 'ClausNftMarket' : 'StrategyOfferMarket', admin,
    nativeMarket ? [nft.target, c.addresses[5]] : [nft.target]);
  const config = treasuryConfig({ token: token.target, nft: nft.target, market: market.target, initializer: c.addresses[0], ...options.config });
  const treasury = await deploy('StrategyTreasury', admin, [config]);
  const executor = await deploy('MockExecutor', admin, [token.target, treasury.target]);
  await tx(token.transfer(executor.target, E('100000000')));
  if (options.initialize !== false) await tx(treasury.initializeHook(executor.target));
  async function list(id = 1, price = E('0.1')) {
    await tx(nft.mint(c.addresses[1], id));
    await tx(nft.connect(seller).approve(market.target, id));
    await tx(market.connect(seller).list(id, price));
    return market.listings(id);
  }
  async function purchase(id = 1) {
    const l = await market.listings(id);
    return tx(treasury.connect(attacker).purchaseCheapest(id, l.revision));
  }
  return { ...c, admin, seller, buyer, attacker, nft, token, market, treasury, executor, config, list, purchase };
}

export async function deployHook(signer, args, deployer) {
  deployer ??= await deploy('Create2Deployer', signer);
  const a = artifacts.StrategyV4Hook;
  const data = (await new ContractFactory(a.abi, a.bytecode, signer).getDeployTransaction(...args)).data;
  const hash = keccak256(data);
  let salt, address;
  for (let i = 0; i < 2_000_000; i++) {
    salt = toBeHex(i, 32);
    address = getCreate2Address(deployer.target, salt, hash);
    if ((BigInt(address) & 0x3fffn) === 0x30ccn) break;
    if (i === 1_999_999) throw new Error('No hook salt');
  }
  await tx(deployer.deploy(salt, data));
  return new Contract(address, a.abi, signer);
}

export function sqrt(value) {
  if (value < 2n) return value;
  let x = value, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + value / x) / 2n; }
  return x;
}

export async function v4Fixture(t, options = {}) {
  const c = await chain(t);
  const [admin, seller, buyer, attacker] = c.signers;
  const tokenOnly = options.mode === 'token-only';
  const seed = options.seed ?? (tokenOnly ? 2n : E('100'));
  const supply = E('1000000000');
  const manager = await deploy('PoolManager', admin, [c.addresses[0]]);
  const initializer = await deploy(tokenOnly ? 'StrategyTokenOnlyInitializer' : 'StrategyInitializer', admin,
    tokenOnly ? [c.addresses[0]] : [c.addresses[0], E('1')]);
  const token = await deploy('StrategyToken', admin, ['Claus Strategy', 'CLSTR', supply, initializer.target]);
  const nft = await deploy('MockNFT', admin);
  const seaportDependencies = options.market === 'opensea'
    ? await (await import('./seaport-helper.mjs')).deploySeaportMarket(admin,nft) : {};
  const market = seaportDependencies.market ?? await deploy('ClausNftMarket', admin, [nft.target, c.addresses[5]]);
  const config = treasuryConfig({ token: token.target, nft: nft.target, market: market.target, initializer: initializer.target, ...options.config });
  const treasury = await deploy('StrategyTreasury', admin, [config]);
  const hook = await deployHook(admin, [manager.target, token.target, treasury.target, initializer.target, 200, 1800, options.slippageBps ?? 500]);
  const router = await deploy('PoolSwapTest', admin, [manager.target]);
  const sqrtPriceX96 = tokenOnly ? 500265532822226746854230870154974n : sqrt((supply << 192n) / seed);
  if (options.initialize !== false) await tx(initializer.initialize(treasury.target, hook.target, sqrtPriceX96, { value: seed }));
  const key = [ZeroAddress, token.target, 0, 60, hook.target];
  const swap = async (signer, buy, amount, overrides = {}) => {
    if (!buy) await tx(token.connect(signer).approve(router.target, amount));
    return tx(router.connect(signer).swap(key,
      [buy, -amount, buy ? 4295128740n : 1461446703485210103287273052203988822378723970341n],
      [false, false], '0x', { value: buy ? amount : 0n, ...overrides }));
  };
  return { ...c, ...seaportDependencies, admin, seller, buyer, attacker, manager, initializer, token, nft, market, config, treasury, hook, router, seed, supply, sqrtPriceX96, key, swap };
}
