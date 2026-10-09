import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { buildLaunchGraph, validateGraphConfig, initialSqrtPriceX96, runtimeImmutables } from '../scripts/build-launch-graph.mjs';
import { validateOfficialInput } from '../scripts/prepare-launch.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = JSON.parse(await readFile(path.join(root, 'config/programmable.example.json'), 'utf8'));
const opensea = JSON.parse(await readFile(path.join(root, 'config/opensea.ethereum-release.json'), 'utf8'));
const fixture = () => ({ ...structuredClone(example), launchWallet: '0x1111111111111111111111111111111111111111',
  metadata: { ...example.metadata, name: 'Synthetic strategy test', symbol: 'TEST', imagePath: 'image.png', imageUri: 'https://example.com/image.png', website: 'https://example.com/', x: 'https://x.com/fixture' },
  economics: { ...example.economics, mode: 'balanced', tokenSupplyBaseUnits: '1000000000000000000000000', initialLiquidityWei: '1000000000000000000', maxLaunchValueWei: '1000000000000000000', maxGasCostWei: '100000000000000000' },
  strategy: { ...example.strategy, purchaseBotAddress: '0x3333333333333333333333333333333333333333', maxBuybackAmountWei: '10000000000000000' },
  publication: { sourceUrl: 'https://example.com/source', sourceRevision: '11'.repeat(20), sourceLineageNonce: '1', launchNonce: `0x${'77'.repeat(32)}`, validAfter: String(Math.floor(Date.now() / 1000) - 60), deadline: String(Math.floor(Date.now() / 1000) + 7200) },
});

test('confirmed collection and fee persist while unknown capital cannot produce a launch graph', () => {
  assert.equal(example.nftCollection.address, '0x80396c7131159eB92E7E84839e51C9887A7A95d9');
  assert.equal(example.economics.strategyFeeBps, 200);
  assert.equal(example.strategy.acquisitionVenue, 'opensea');
  assert.equal(example.strategy.collectionSlug, 'contractclaus');
  assert.equal(example.strategy.maxPurchasePriceWei, '0');
  assert.equal(example.strategy.maxSpendPerEpochWei, '0');
  assert.equal(example.strategy.pricingPolicy.mode, 'trusted-bot');
  assert.equal(example.strategy.purchaseBotAddress, null);
  assert.ok(validateGraphConfig(example).some(e => e.includes('controller wallet')));
  const missingCap = fixture(); missingCap.strategy.maxPurchasePriceWei = null;
  assert.ok(validateGraphConfig(missingCap).some(e => e.includes('maxPurchasePriceWei')));
  assert.deepEqual(validateGraphConfig(fixture()), []);
  const changed = fixture(); changed.chainId = 4663;
  assert.ok(validateGraphConfig(changed).some(e => e.includes('Ethereum-only')));
  changed.chainId = 1; changed.strategy.maxPurchasePriceWei = '2'; changed.strategy.maxSpendPerEpochWei = '1';
  assert.ok(validateGraphConfig(changed).some(e => e.includes('Epoch cap')));
});

test('uncapped configuration requires explicit trusted-bot authority and matched no-ceiling settings', () => {
  const config = fixture();
  assert.deepEqual(validateGraphConfig(config), []);
  config.strategy.purchaseBotAddress = null;
  assert.ok(validateGraphConfig(config).some(e => e.includes('purchaseBotAddress')));
  config.strategy.purchaseBotAddress = '0x3333333333333333333333333333333333333333';
  config.strategy.pricingPolicy = { mode: 'pending' };
  const blockers = validateGraphConfig(config);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /Pricing policy is not selected/);
  config.strategy.maxSpendPerEpochWei = '1';
  assert.ok(validateGraphConfig(config).some(e => e.includes('Disable both')));
});

test('OpenSea graph cannot silently retain a native marketplace or an unspecified acquisition venue', () => {
  const config = fixture();
  config.strategy.marketAddress = '0x7832B1B34B8dBec979a44634BC095821c91FFc95';
  assert.ok(validateGraphConfig(config).some(e => e.includes('pinned adapter')));
  config.strategy.acquisitionVenue = 'native';
  assert.deepEqual(validateGraphConfig(config), []);
  delete config.strategy.marketAddress;
  assert.ok(validateGraphConfig(config).some(e => e.includes('native marketplace')));
  delete config.strategy.acquisitionVenue;
  assert.ok(validateGraphConfig(config).some(e => e.includes('acquisitionVenue')));
  config.strategy.acquisitionVenue = 'opensea';
  config.strategy.collectionSlug = '../other-collection';
  assert.ok(validateGraphConfig(config).some(e => e.includes('collectionSlug')));
});

test('initial pool price is the integer square root of the funded asset ratio', () => {
  assert.equal(initialSqrtPriceX96('100', '100'), (1n << 96n).toString());
  const supply = 10n ** 24n, seed = 10n ** 18n;
  const q = BigInt(initialSqrtPriceX96(supply, seed)), n = (supply << 192n) / seed;
  assert.ok(q * q <= n && (q + 1n) * (q + 1n) > n);
});

test('new unmapped immutables fail closed instead of publishing guessed runtime bytes', () => {
  assert.throws(() => runtimeImmutables({ sources: { x: { ast: { nodeType: 'VariableDeclaration', mutability: 'immutable', id: 99, name: 'unexpected' } } } },
    { evm: { deployedBytecode: { immutableReferences: { 99: [{}] } } } }, {}), /Unmapped runtime immutable/);
});

for (const mode of ['balanced', 'token-only']) test(`actual ${mode} contracts produce an exact graph with correct funding, fee and immutable bindings`, { timeout: 180000 }, async t => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'claus-launch-graph-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const configPath = path.join(temp, 'config.json'), out = path.join(temp, 'out');
  const launchConfig = fixture(); launchConfig.economics.mode = mode;
  if (mode === 'token-only') launchConfig.economics.initialLiquidityWei = '2';
  await writeFile(configPath, JSON.stringify(launchConfig));
  await writeFile(path.join(temp, 'image.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const report = await buildLaunchGraph(configPath, out);
  assert.deepEqual(report.blockers, []);
  assert.equal(report.officialSchemaValid, true);
  assert.equal(report.deployed, false);
  const config = JSON.parse(await readFile(report.packConfigPath, 'utf8'));
  assert.deepEqual(await validateOfficialInput(config, 1), []);
  assert.equal(config.profileVersion, '3.6.0');
  assert.deepEqual(config.targets.map(t => t.targetId), ['initializer', 'token', 'market', 'treasury', 'hook']);
  const byId = Object.fromEntries(config.targets.map(t => [t.targetId, t]));
  assert.equal(byId.initializer.constructorArguments[0], '0xB012e4A8F2c5FC4E8E4faCA9D5Ad6FfF13FBA887');
  assert.equal(byId.initializer.initializerValueWei, launchConfig.economics.initialLiquidityWei);
  assert.equal(config.pool.fee, 0);
  if (mode === 'token-only') {
    assert.equal(byId.initializer.constructorArguments.length, 1);
    assert.equal(byId.initializer.runtimeImmutables.length, 1);
    assert.equal(byId.initializer.initializer.arguments[2], '500265532822226746854230870154974');
  }
  assert.deepEqual(byId.initializer.initializer.arguments.slice(0, 2), [{ target: 'treasury' }, { target: 'hook' }]);
  assert.deepEqual(byId.token.constructorArguments[3], { target: 'initializer' });
  assert.equal(byId.hook.constructorArguments[4], 200);
  assert.equal(config.launchProfile.applicantSelectedBuyHundredthsOfBip, '20000');
  assert.equal(config.launchProfile.liquidityModel.declaredLaunchState, 'assessment_required');
  assert.equal(byId.treasury.constructorArguments[0][1], example.nftCollection.address);
  assert.deepEqual(byId.treasury.constructorArguments[0][2], { target: 'market' });
  assert.deepEqual(byId.market.constructorArguments, [example.nftCollection.address, opensea.seaport, opensea.conduitController, opensea.allowedZone, launchConfig.strategy.purchaseBotAddress]);
  assert.equal(byId.market.runtimeImmutables.length, 5);
  for (const value of [example.nftCollection.address, opensea.seaport, opensea.conduitController, opensea.allowedZone, launchConfig.strategy.purchaseBotAddress]) {
    assert.ok(byId.market.runtimeImmutables.some(immutable => immutable.abiType === 'address' && immutable.literal === value));
  }
  assert.ok(byId.treasury.runtimeImmutables.some(immutable => immutable.abiType === 'address' && immutable.target === 'market'));
  assert.equal(report.acquisitionVenue, 'opensea');
  assert.deepEqual(report.pricingPolicy, { mode: 'trusted-bot' });
  assert.equal(report.purchaseBotAddress, launchConfig.strategy.purchaseBotAddress);
  assert.equal(byId.treasury.constructorArguments[0][6], '0');
  assert.equal(byId.treasury.constructorArguments[0][7], '0');
  assert.equal(report.marketplaceDependencies.runtimeCodeVerified, false);
  assert.equal(byId.hook.runtimeImmutables.length, 7);
  assert.equal(byId.treasury.runtimeImmutables.length, 13);
  const input = JSON.parse(await readFile(path.join(out, 'standard-json/strategy.json'), 'utf8'));
  for (const [name, { content }] of Object.entries(input.sources)) assert.equal(await readFile(path.join(out, name), 'utf8'), content);
  // Optional release-level proof. Install the checksum-verified official CLI into
  // ignored artifacts/programmable-cli first; no network or credentials used here.
  const cliRoot = path.join(root, 'artifacts/programmable-cli/node_modules/@programmable/launch');
  try { await access(path.join(cliRoot, 'src/pack.mjs')); } catch { t.diagnostic('Official CLI not installed: schema/source/ABI tests passed; release-level packing unverified.'); return; }
  const { buildLaunch } = await import(pathToFileURL(path.join(cliRoot, 'src/pack.mjs')).href);
  const built = await buildLaunch({ configPath: report.packConfigPath });
  const request = JSON.parse(built.requestBytes);
  assert.equal(request.launchProfile.profileVersion, '3.6.0');
  assert.equal(request.graphBundle.targets.length, 5);
  assert.ok(request.graphBundle.targets.find(t => t.targetId === 'market').expectedRuntimeCodeHash);
  const graphHook = request.graphBundle.targets.find(t => t.targetId === 'hook');
  assert.ok(graphHook.expectedRuntimeCodeHash);
  assert.equal(BigInt(built.predictions.find(t => t.targetId === 'hook').predictedAddress) & 0x3fffn, 0x30ccn);
  assert.equal(request.graphBundle.targets.reduce((sum, t) => sum + BigInt(t.deploymentValueWei) + BigInt(t.initializerValueWei), 0n), BigInt(launchConfig.economics.initialLiquidityWei));
  // Save a clearly synthetic local proof to make the actual official pack result reviewable.
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  await writeFile(path.join(root, `artifacts/launch-graph-${mode}-test-proof.json`), JSON.stringify({
    scope: 'synthetic fixtures; no production metadata or source-publication claim', officialCliVersion: '4.1.4',
    profileVersion: request.launchProfile.profileVersion, requestSha256: built.requestSha256, liquidityMode: mode, nodeVersion: process.version,
    standardJsonSha256: report.standardJsonSha256,
    acquisitionVenue: report.acquisitionVenue, pricingPolicy: report.pricingPolicy,
    purchaseBotAddress: report.purchaseBotAddress, purchaseLimitWei: launchConfig.strategy.maxPurchasePriceWei, epochLimitWei: launchConfig.strategy.maxSpendPerEpochWei,
    graphTargetCount: request.graphBundle.targets.length, hookMask: '0x30cc', graphValueWei: launchConfig.economics.initialLiquidityWei, deployed: false, signed: false,
  }, null, 2));
});
