import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateConfig, validateLiveCapabilities, validateOfficialInput, inspectPlatformTrading, prepare } from '../scripts/prepare-launch.mjs';

const exampleUrl = new URL('../config/programmable.example.json', import.meta.url);
const example = JSON.parse(await readFile(exampleUrl, 'utf8'));
const valid = () => ({
  ...structuredClone(example),
  chainId: 1,
  nftCollection: { chainId: 1, address: '0x1111111111111111111111111111111111111111' },
  launchWallet: '0x2222222222222222222222222222222222222222',
  metadata: { ...example.metadata, symbol: 'CLAUS', imagePath: 'actual.png', imageUri: 'ipfs://actual-content-id', website: 'https://example.com', x: 'https://x.com/example' },
  economics: { strategyFeeBps: 500, saleMultiplierBps: 11000, initialLiquidityWei: '100', maxLaunchValueWei: '100', maxGasCostWei: '10' },
  strategy: { ...example.strategy, purchaseBotAddress: '0x3333333333333333333333333333333333333333' },
  officialInputPath: 'official-input.json',
});

test('an unconfigured template never claims launch readiness', async () => {
  const report = await prepare(fileURLToPath(exampleUrl));
  assert.equal(report.readyForOfficialPacking, false);
  assert.equal(report.readyForWallet, false);
  assert.equal(report.moduleCatalog.catalogPublished, false);
  assert.equal(report.chainId, 1);
  assert.ok(report.blockers.some((item) => item.includes('controller wallet')));
  assert.ok(report.blockers.some((item) => item.includes('purchaseBotAddress')));
  assert.equal(report.acquisitionPolicy.noFixedCeilings, true);
  assert.equal(report.acquisitionPolicy.fixedPurchaseCeilingWei, null);
  assert.equal(report.acquisitionPolicy.fixedEpochCeilingWei, null);
  assert.deepEqual(report.callsMade, { authenticatedApi: false, preflight: false, submit: false, wallet: false });
});

test('collection and token cannot silently use different chains', () => {
  const config = valid();
  assert.deepEqual(validateConfig(config), []);
  config.nftCollection.chainId = 4663;
  assert.ok(validateConfig(config).some((item) => item.includes('same selected chain')));
});

test('unknown economics and changed markup fail preparation', () => {
  const config = valid();
  config.economics.maxGasCostWei = null;
  config.economics.saleMultiplierBps = 10000;
  config.economics.maxLaunchValueWei = '99';
  const blockers = validateConfig(config);
  assert.ok(blockers.some((item) => item.includes('maxGasCostWei')));
  assert.ok(blockers.some((item) => item.includes('11000')));
  assert.ok(blockers.some((item) => item.includes('below declared initial liquidity')));
});

test('metadata rejected by the current profile fails before packing', () => {
  const privatePreview = valid();
  privatePreview.publication.websiteAccess = 'private';
  assert.ok(validateConfig(privatePreview).some(message => message.includes('private preview')));
  for (const invalid of ['https://x.com/a/b', 'https://x.com/name/', 'https://x.com/not-a-handle', 'https://x.com/' + 'a'.repeat(65)]) {
    const config = valid();
    config.metadata.x = invalid;
    assert.ok(validateConfig(config).some(message => message.includes('canonical public')));
  }
  for (const invalid of ['https://localhost', 'https://127.0.0.1', 'https://192.168.1.2', 'https://[::1]']) {
    const config = valid();
    config.metadata.website = invalid;
    assert.ok(validateConfig(config).some(message => message.includes('public HTTPS website')));
  }
  for (const invalid of ['a'.repeat(4097), '.....................', ' A useful public description for this token.']) {
    const config = valid();
    config.metadata.description = invalid;
    assert.ok(validateConfig(config).some(message => message.includes('UTF-8 bytes')));
  }
});

test('deployment availability cannot be mistaken for live coin trading', async () => {
  const live = JSON.parse(await readFile(new URL('../docs/verification/programmable-capabilities.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateLiveCapabilities(1, live), []);
  const trading = inspectPlatformTrading(live);
  assert.equal(trading.status, 'disabled');
  assert.equal(trading.reasonCode, 'PROVIDER_IDENTITY_CONFIG_MISSING');
  assert.equal(trading.coinTradingVerified, false);
  assert.equal(trading.scope, 'programmable-onsite-only');
  assert.equal(trading.blocksIndependentWebsiteRoute, false);
  assert.ok(trading.blockers.some(message => message.includes('disabled')));
  assert.ok(inspectPlatformTrading({}).blockers.length > 0);
});

test('disabled live create or stale manifest cannot pass Robinhood gate', () => {
  const caps = { chainId: '4663', manifestDigest: 'current', availability: { operations: { create: { state: 'disabled' }, preflight: { state: 'active' } } } };
  const blockers = validateLiveCapabilities(4663, caps, { manifestDigest: 'old' });
  assert.ok(blockers.some((item) => item.includes('create operation')));
  assert.ok(blockers.some((item) => item.includes('manifest changed')));
});

test('Ethereum gate rejects wrong chain and unadmitted profile', () => {
  const caps = { chain: { id: '4663' }, profile: { profileId: 'programmable.direct-native-hook-graph.v1', profileRevision: 3, productionLaunchAuthorized: true }, requestProfiles: { freshSubmissionExactVersions: ['3.3.0'] } };
  const blockers = validateLiveCapabilities(1, caps, { profileVersion: '3.4.0', launchProfile: { profileRevision: 3 } });
  assert.ok(blockers.some((item) => item.includes('bind Ethereum')));
  assert.ok(blockers.some((item) => item.includes('not admitted')));
});

test('pinned official Ethereum and Robinhood schemas reject incomplete inputs offline', async () => {
  for (const chain of [1, 4663]) {
    const errors = await validateOfficialInput({}, chain);
    assert.ok(errors.length > 0);
    assert.ok(errors.some((error) => error.includes('required')));
  }
});
