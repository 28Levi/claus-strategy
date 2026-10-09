#!/usr/bin/env node
// Writes unsigned exact-source inputs for the official CLI. No wallet, RPC or API credentials.
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import solc from 'solc';
import { keccak256, toUtf8Bytes } from 'ethers';
import { validateConfig, validateOfficialInput } from './prepare-launch.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ZERO = '0x0000000000000000000000000000000000000000';
const MAX_SIGNED128 = (1n << 127n) - 1n;
const RELEASE = JSON.parse(await readFile(path.join(ROOT, 'config/programmable.ethereum-release.json'), 'utf8'));
const OPENSEA = JSON.parse(await readFile(path.join(ROOT, 'config/opensea.ethereum-release.json'), 'utf8'));
const CONTRACTS = { initializer: 'StrategyInitializer', token: 'StrategyToken', treasury: 'StrategyTreasury', hook: 'StrategyV4Hook' };
const TOKEN_ONLY_SQRT_PRICE_X96 = '500265532822226746854230870154974';
function contractsFor(mode, acquisitionVenue = 'opensea') {
  const base = mode === 'token-only' ? { ...CONTRACTS, initializer: 'StrategyTokenOnlyInitializer' } : CONTRACTS;
  return acquisitionVenue === 'opensea'
    ? { initializer: base.initializer, token: base.token, market: 'SeaportListingMarket', treasury: base.treasury, hook: base.hook }
    : base;
}
const PERMISSIONS = ['beforeInitialize', 'afterInitialize', 'beforeSwap', 'afterSwap', 'beforeSwapReturnDelta', 'afterSwapReturnDelta'];
const UINT = /^(0|[1-9][0-9]*)$/;
const address = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) && v.toLowerCase() !== ZERO;
const uint = (v, max = (1n << 256n) - 1n, min = 0n) => typeof v === 'string' && UINT.test(v) && BigInt(v) >= min && BigInt(v) <= max;
const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

export function validateGraphConfig(config) {
  // officialInputPath is output of this builder, not a required input.
  const blockers = validateConfig({ ...config, officialInputPath: 'generated-pack-config.json' });
  const require = (ok, message) => { if (!ok) blockers.push(message); };
  require(config.chainId === 1, 'This graph builder is Ethereum-only. It never silently changes chains.');
  const e = config.economics ?? {}, s = config.strategy ?? {}, p = config.publication ?? {};
  require(['balanced', 'token-only'].includes(e.mode), 'Choose economics.mode balanced or token-only explicitly.');
  if (e.mode === 'token-only') require(e.initialLiquidityWei === '2', 'Token-only reference mode requires exactly 2 wei of locked transaction value.');
  require(uint(e.initialLiquidityWei, MAX_SIGNED128, 1n), 'Set positive economics.initialLiquidityWei within int128; this funds permanently locked liquidity.');
  require(uint(e.tokenSupplyBaseUnits, MAX_SIGNED128, 1n), 'Set economics.tokenSupplyBaseUnits explicitly (18 decimal base units, int128 bound).');
  require(['opensea', 'native'].includes(s.acquisitionVenue), 'Choose strategy.acquisitionVenue opensea or native explicitly.');
  if (s.acquisitionVenue === 'opensea') {
    require(typeof s.collectionSlug === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(s.collectionSlug), 'Set strategy.collectionSlug to the actual OpenSea collection slug.');
    require(s.marketAddress == null, 'OpenSea acquisition deploys its own pinned adapter; remove the external strategy.marketAddress.');
  } else if (s.acquisitionVenue === 'native') {
    require(address(s.marketAddress), 'Set strategy.marketAddress to a verified revisioned native marketplace for this collection.');
  }
  require(uint(s.firstTokenId), 'Set strategy.firstTokenId as a decimal string.');
  require(Number.isInteger(s.tokenCount) && s.tokenCount > 0 && s.tokenCount <= 512, 'Set strategy.tokenCount between 1 and 512.');
  require(uint(s.maxPurchasePriceWei), 'Set strategy.maxPurchasePriceWei as a uint256 decimal string; zero explicitly disables the fixed ceiling.');
  require(uint(s.maxSpendPerEpochWei), 'Set strategy.maxSpendPerEpochWei as a uint256 decimal string; zero explicitly disables the fixed epoch ceiling.');
  if (uint(s.maxPurchasePriceWei) && uint(s.maxSpendPerEpochWei)) {
    const noCeiling = s.maxPurchasePriceWei === '0';
    require(noCeiling === (s.maxSpendPerEpochWei === '0'), 'Disable both fixed NFT spending ceilings together by setting both to zero.');
    if (!noCeiling) require(BigInt(s.maxSpendPerEpochWei) >= BigInt(s.maxPurchasePriceWei), 'Epoch cap must cover one maximum purchase.');
  }
  if (uint(s.firstTokenId) && Number.isInteger(s.tokenCount)) require(BigInt(s.firstTokenId) + BigInt(s.tokenCount) <= (1n << 256n) - 1n, 'NFT ID range overflows uint256.');
  for (const [key, minimum] of [['epochDurationSeconds', 3600], ['minPurchaseIntervalSeconds', 60], ['minBuybackIntervalSeconds', 60]]) {
    require(Number.isInteger(s[key]) && s[key] >= minimum && s[key] <= 0xffffffff, `Set strategy.${key} between ${minimum} and uint32 maximum.`);
  }
  require(Number.isInteger(s.maxInventory) && s.maxInventory > 0 && s.maxInventory <= s.tokenCount, 'Set strategy.maxInventory within the collection scan range.');
  require(uint(s.maxBuybackAmountWei, MAX_SIGNED128, 1n), 'Set positive strategy.maxBuybackAmountWei within int128.');
  require(Number.isInteger(s.twapWindowSeconds) && s.twapWindowSeconds >= 1800 && s.twapWindowSeconds <= 3600, 'Set strategy.twapWindowSeconds between 1800 and 3600.');
  require(Number.isInteger(s.maxSlippageBps) && s.maxSlippageBps >= 0 && s.maxSlippageBps <= 1000, 'Set strategy.maxSlippageBps between 0 and 1000.');
  try { const u = new URL(p.sourceUrl); require(u.protocol === 'https:' && !u.username && !u.password && !u.hash, 'Set a credential-free HTTPS publication.sourceUrl.'); } catch { require(false, 'Set publication.sourceUrl to the actual public source repository.'); }
  require(typeof p.sourceRevision === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(p.sourceRevision), 'Set publication.sourceRevision to the actual immutable public source revision.');
  require(uint(p.sourceLineageNonce), 'Set publication.sourceLineageNonce explicitly.');
  require(typeof p.launchNonce === 'string' && /^0x(?!0{64}$)[0-9a-f]{64}$/.test(p.launchNonce), 'Set publication.launchNonce to a fresh nonzero bytes32. Preserve it for exact retries.');
  require(uint(p.validAfter), 'Set publication.validAfter as a Unix timestamp string.');
  require(uint(p.deadline, undefined, 1n), 'Set publication.deadline as a Unix timestamp string.');
  if (uint(p.validAfter) && uint(p.deadline)) {
    require(BigInt(p.deadline) > BigInt(p.validAfter), 'Publication deadline must follow validAfter.');
    require(BigInt(p.deadline) - BigInt(p.validAfter) <= 86400n, 'The current official permit window cannot exceed 86400 seconds.');
  }
  return blockers;
}

export function initialSqrtPriceX96(tokenSupply, nativeSeed) {
  const n = (BigInt(tokenSupply) << 192n) / BigInt(nativeSeed);
  if (n <= 0n) throw new Error('Initial price cannot be zero.');
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) { const y = (x + n / x) >> 1n; if (y >= x) return x.toString(); x = y; }
}

export async function compileLaunchSources(mode = 'balanced', acquisitionVenue = 'opensea') {
  if (solc.version() !== '0.8.26+commit.8a97fa7a.Emscripten.clang') throw new Error('Exact solc 0.8.26 build is required.');
  const sources = {}, pending = Object.values(contractsFor(mode, acquisitionVenue)).map(n => `contracts/${n}.sol`);
  while (pending.length) {
    const name = pending.shift();
    if (sources[name]) continue;
    if (name.startsWith('../') || path.posix.isAbsolute(name)) throw new Error('Unsafe source path.');
    const base = name.startsWith('contracts/') ? ROOT : path.join(ROOT, 'node_modules');
    const content = await readFile(path.join(base, name), 'utf8');
    sources[name] = { content };
    for (const m of content.matchAll(/^\s*import\s+(?:[^;]*?\sfrom\s+)?["']([^"']+)["']\s*;/gm)) {
      pending.push(m[1].startsWith('.') ? path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1])) : m[1]);
    }
  }
  const input = { language: 'Solidity', sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))), settings: {
    optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
    metadata: { bytecodeHash: 'none', appendCBOR: false, useLiteralContent: true },
    outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode'], '': ['ast'] } },
  } };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  return { input, output };
}

export function runtimeImmutables(output, compiled, values) {
  const declarations = new Map();
  function walk(n) {
    if (!n || typeof n !== 'object') return;
    if (n.nodeType === 'VariableDeclaration' && n.mutability === 'immutable') declarations.set(String(n.id), n.name);
    for (const v of Object.values(n)) if (v && typeof v === 'object') Array.isArray(v) ? v.forEach(walk) : walk(v);
  }
  Object.values(output.sources).forEach(s => walk(s.ast));
  return Object.keys(compiled.evm.deployedBytecode.immutableReferences ?? {}).map(immutableId => {
    const name = declarations.get(immutableId), value = values[name];
    if (!value) throw new Error(`Unmapped runtime immutable ${immutableId} (${name}); refusing to guess.`);
    return { immutableId, ...value };
  });
}

export async function buildLaunchGraph(configPath, outDir, options = {}) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const blockers = validateGraphConfig(config);
  const report = { schemaVersion: 'claus.launch-graph-build.v1', checkedAt: new Date().toISOString(), profileVersion: RELEASE.profileVersion,
    blockers, sourceCompiled: false, officialSchemaValid: false, officialCliPacked: false, remotelyAdmitted: false, deployed: false,
    fees: { strategyBps: config.economics?.strategyFeeBps, poolBps: 0, additionalProgrammableRoutedBps: RELEASE.routedPlatformFeeBps },
    sourceRevisionVerified: false, dependencyRuntimesVerified: false };
  const out = path.resolve(outDir);
  await mkdir(out, { recursive: true });
  // Never leave an earlier successful config looking current after a blocked rebuild.
  await unlink(path.join(out, 'programmable-launch.config.json')).catch(e => { if (e.code !== 'ENOENT') throw e; });
  if (!blockers.length) {
    const image = path.resolve(path.dirname(path.resolve(configPath)), config.metadata.imagePath);
    try { await readFile(image); } catch { blockers.push('The actual metadata image file is missing.'); }
    if (!blockers.length) {
      const { input, output } = options.compilation ?? await compileLaunchSources(config.economics.mode, config.strategy.acquisitionVenue);
      const e = config.economics, s = config.strategy, p = config.publication;
      const tokenOnly = e.mode === 'token-only';
      const openSea = s.acquisitionVenue === 'opensea';
      const literal = (abiType, value) => ({ abiType, literal: /^u?int/.test(abiType) ? String(value) : value });
      const target = value => ({ abiType: 'address', target: value });
      const refs = { token: target('token'), initializer: target('initializer'), collection: literal('address', config.nftCollection.address), market: openSea ? target('market') : literal('address', s.marketAddress),
        firstTokenId: literal('uint256', s.firstTokenId), tokenCount: literal('uint256', String(s.tokenCount)),
        maxPurchasePrice: literal('uint256', s.maxPurchasePriceWei), maxSpendPerEpoch: literal('uint256', s.maxSpendPerEpochWei),
        epochDuration: literal('uint32', s.epochDurationSeconds), minPurchaseInterval: literal('uint32', s.minPurchaseIntervalSeconds),
        maxInventory: literal('uint32', s.maxInventory), maxBuybackAmount: literal('uint256', s.maxBuybackAmountWei), minBuybackInterval: literal('uint32', s.minBuybackIntervalSeconds) };
      const immutableValues = {
        initializer: { launchAuthority: literal('address', RELEASE.graphFactory), ...(tokenOnly ? {} : { minNativeSeed: literal('uint256', e.initialLiquidityWei) }) },
        token: {}, treasury: refs,
        market: { collection: literal('address', config.nftCollection.address), seaport: literal('address', OPENSEA.seaport), conduitController: literal('address', OPENSEA.conduitController), allowedZone: literal('address', OPENSEA.allowedZone), purchaseBot: literal('address', s.purchaseBotAddress) },
        hook: { poolManager: literal('address', RELEASE.poolManager), token: target('token'), treasury: target('treasury'), poolInitializer: target('initializer'),
          feeBps: literal('uint16', e.strategyFeeBps), twapWindow: literal('uint32', s.twapWindowSeconds), maxSlippageBps: literal('uint16', s.maxSlippageBps) },
      };
      const constructorArguments = {
        initializer: tokenOnly ? [RELEASE.graphFactory] : [RELEASE.graphFactory, e.initialLiquidityWei],
        token: [config.metadata.name, config.metadata.symbol, e.tokenSupplyBaseUnits, { target: 'initializer' }],
        market: [config.nftCollection.address, OPENSEA.seaport, OPENSEA.conduitController, OPENSEA.allowedZone, s.purchaseBotAddress],
        treasury: [[{ target: 'token' }, config.nftCollection.address, openSea ? { target: 'market' } : s.marketAddress, { target: 'initializer' }, s.firstTokenId, String(s.tokenCount),
          s.maxPurchasePriceWei, s.maxSpendPerEpochWei, s.epochDurationSeconds, s.minPurchaseIntervalSeconds, s.maxInventory, s.maxBuybackAmountWei, s.minBuybackIntervalSeconds]],
        hook: [RELEASE.poolManager, { target: 'token' }, { target: 'treasury' }, { target: 'initializer' }, e.strategyFeeBps, s.twapWindowSeconds, s.maxSlippageBps],
      };
      const artifacts = {}, targets = [];
      for (const [id, name] of Object.entries(contractsFor(e.mode, s.acquisitionVenue))) {
        const c = output.contracts[`contracts/${name}.sol`][name];
        if (c.evm.deployedBytecode.object.length / 2 > 24576) throw new Error(`${name} exceeds EIP-170.`);
        artifacts[id] = { abi: c.abi, metadata: c.metadata, bytecode: c.evm.bytecode, deployedBytecode: c.evm.deployedBytecode };
        targets.push({ targetId: id, compilationUnitId: 'claus-solc-0826', artifact: `artifacts/${id}.json`,
          applicantSalt: id === 'hook' ? { mode: 'deterministic-hook-permission-grind-v1', start: '0', maxAttempts: '1000000' } : keccak256(toUtf8Bytes(`claus-strategy.v1:${p.launchNonce}:${id}`)),
          constructorArguments: constructorArguments[id],
          initializer: id === 'initializer' ? { function: 'initialize', arguments: [{ target: 'treasury' }, { target: 'hook' }, tokenOnly ? TOKEN_ONLY_SQRT_PRICE_X96 : initialSqrtPriceX96(e.tokenSupplyBaseUnits, e.initialLiquidityWei)] } : null,
          deploymentValueWei: '0', initializerValueWei: id === 'initializer' ? e.initialLiquidityWei : '0',
          componentKind: id === 'token' || id === 'hook' ? id : 'other', declaredHookPermissions: id === 'hook' ? PERMISSIONS : null,
          runtimeImmutables: runtimeImmutables(output, c, immutableValues[id]) });
      }
      const imagePath = `assets/project${path.extname(image).toLowerCase()}`;
      const packed = {
        schemaVersion: 'programmable.launch-pack-config.v3', profileVersion: '3.6.0', launchWallet: config.launchWallet, chainId: '1', nonce: p.launchNonce,
        source: { root: '.', paths: [...Object.keys(input.sources), 'package-lock.json', imagePath], sourceLineageNonce: p.sourceLineageNonce, publicOrigin: { url: p.sourceUrl, revision: p.sourceRevision } },
        compilationUnits: [{ compilationUnitId: 'claus-solc-0826', standardJson: 'standard-json/strategy.json' }], targets,
        pool: { tokenTargetId: 'token', hookTargetId: 'hook', fee: 0, tickSpacing: 60, quoteCurrency: ZERO },
        projectMetadata: { schemaVersion: 'programmable.project-metadata-input.v1', token: { name: config.metadata.name, symbol: config.metadata.symbol }, presentation: {
          description: config.metadata.description, image: { sourcePath: imagePath, uri: config.metadata.imageUri },
          links: [{ kind: 'website', uri: config.metadata.website }, { kind: 'x', uri: config.metadata.x }] } },
        launchProfile: { schemaVersion: 'programmable.direct-native-hook-graph-profile-selection.v3', profileId: 'programmable.direct-native-hook-graph.v1', profileRevision: 3,
          targetRoles: { tokenTargetId: 'token', hookTargetId: 'hook', initializerTargetId: 'initializer', platformFeeBindingTargetId: 'hook' },
          liquidityModel: { schemaVersion: 'programmable.direct-native-liquidity-model-intent.v1', model: 'launch-seeded-concentrated-liquidity', declaredLaunchState: 'assessment_required', liquidityTargetId: 'initializer',
            assessment: { schemaVersion: 'programmable.direct-native-liquidity-model-assessment.v1', status: 'required', requestClaimsExecution: false,
              requiredVectorIds: ['liquidity.seeded.pool-active-liquidity', 'liquidity.seeded.position-custody-and-withdrawal', 'liquidity.seeded.buy-and-sell'] } },
          fundingMode: 'wallet-transaction-value', accountingMode: 'additive-platform-share', assessmentBase: 'executed-gross-declared-quote', feeCurrency: 'declared-quote-currency',
          claimMode: 'claim-authority-selected-recipient', applicantSelectedBuyHundredthsOfBip: String(e.strategyFeeBps * 100), applicantSelectedSellHundredthsOfBip: String(e.strategyFeeBps * 100) },
        permitWindow: { validAfter: p.validAfter, deadline: p.deadline },
        agentAttestation: { agentId: 'claus-exact-source-builder', checkedAt: report.checkedAt, checks: [{ checkId: 'compiled-source-and-config', evidence: 'evidence/build.json' }] },
      };
      blockers.push(...await validateOfficialInput(packed, 1));
      report.sourceCompiled = true;
      report.officialSchemaValid = blockers.length === 0;
      report.compiler = solc.version();
      report.sourceCount = Object.keys(input.sources).length;
      report.targetCount = targets.length;
      report.initialSqrtPriceX96 = targets[0].initializer.arguments[2];
      report.liquidityMode = e.mode;
      report.acquisitionVenue = s.acquisitionVenue;
      report.pricingPolicy = s.pricingPolicy;
      report.purchaseBotAddress = openSea ? s.purchaseBotAddress : null;
      report.marketplaceDependencies = openSea ? { seaport: OPENSEA.seaport, conduitController: OPENSEA.conduitController, allowedZone: OPENSEA.allowedZone, runtimeCodeVerified: false } : { marketAddress: s.marketAddress, runtimeCodeVerified: false };
      report.tokenOnlyHasInitialEthExitReserve = tokenOnly ? false : null;
      report.expectedHookPermissionMask = '0x30cc';
      if (!blockers.length) {
        async function save(file, data) { const dest = path.join(out, file); await mkdir(path.dirname(dest), { recursive: true }); await writeFile(dest, data); }
        for (const [name, { content }] of Object.entries(input.sources)) await save(name, content);
        await save('package-lock.json', await readFile(path.join(ROOT, 'package-lock.json')));
        await save(imagePath, await readFile(image));
        await save('standard-json/strategy.json', `${JSON.stringify(input)}\n`);
        for (const [id, artifact] of Object.entries(artifacts)) await save(`artifacts/${id}.json`, `${JSON.stringify(artifact)}\n`);
        report.standardJsonSha256 = sha(Buffer.from(`${JSON.stringify(input)}\n`));
        report.next = 'Use the checksum-verified official @programmable/launch 4.1.4 packer, then re-read live capabilities and run authenticated preflight. No transaction has been produced or signed.';
        await save('evidence/build.json', `${JSON.stringify(report, null, 2)}\n`);
        await save('programmable-launch.config.json', `${JSON.stringify(packed, null, 2)}\n`);
        report.packConfigPath = path.join(out, 'programmable-launch.config.json');
      }
    }
  }
  await writeFile(path.join(out, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function main() {
  const args = process.argv.slice(2), options = {};
  if (args.includes('--help')) { console.log('node scripts/build-launch-graph.mjs --config config/programmable.local.json --out artifacts/launch [--require-ready]\nCreates exact-source official profile 3.6 inputs. Never signs, submits or broadcasts. Missing budgets and public metadata remain blockers.'); return; }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--require-ready') options.requireReady = true;
    else if (['--config', '--out'].includes(args[i]) && args[i + 1]) options[args[i++].slice(2)] = args[i];
    else throw new Error(`Unknown or incomplete argument ${args[i]}.`);
  }
  const report = await buildLaunchGraph(options.config ?? path.join(ROOT, 'config/programmable.example.json'), options.out ?? path.join(ROOT, 'artifacts/launch'));
  console.log(JSON.stringify(report, null, 2));
  if (options.requireReady && report.blockers.length) process.exitCode = 2;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) main().catch(e => { console.error(e.message); process.exitCode = 1; });
