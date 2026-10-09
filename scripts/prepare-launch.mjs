#!/usr/bin/env node
// Read-only preparation. No wallet access, authenticated calls, or broadcasts.
// Credential availability is reported as booleans; values are never emitted.
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.programmable.market';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/i;
const UINT = /^(0|[1-9][0-9]*)$/;
const ROUTES = {
  1: {
    name: 'Ethereum Mainnet',
    inputKind: 'official-cli-pack-config',
    schemaFile: 'programmable-ethereum-pack-config.v3.6.json',
    capabilities: `${API}/v3/capabilities`,
    guide: 'https://programmable.market/developers/custom-launch-api-v1.md',
  },
  4663: {
    name: 'Robinhood Chain Mainnet',
    inputKind: 'official-launch-plan',
    schemaFile: 'programmable-robinhood-launch-plan.v1.json',
    capabilities: `${API}/v4/chains/4663/custom-launch-capabilities`,
    guide: `${API}/v4/chains/4663/custom-launch-contract/guide.md`,
  },
};

export function validateConfig(config) {
  const blockers = [];
  const required = (condition, message) => { if (!condition) blockers.push(message); };
  required(config?.schemaVersion === 'claus.programmable-preparation.v1', 'Unsupported preparation schema.');
  required([1, 4663].includes(config?.chainId), 'Choose chainId 1 or 4663 explicitly.');
  required(config?.nftCollection?.chainId === config?.chainId && [1, 4663].includes(config?.chainId),
    'NFT collection and strategy token must be on the same selected chain; bridging is not implemented.');
  required(isAddress(config?.nftCollection?.address), 'Supply the real NFT collection address.');
  required(isAddress(config?.launchWallet), 'Supply the controller wallet address.');
  const metadata = config?.metadata ?? {};
  required(typeof metadata.name === 'string' && metadata.name.trim().length > 0, 'Supply token name.');
  required(typeof metadata.symbol === 'string' && /^[^\s]{1,16}$/.test(metadata.symbol), 'Supply token symbol (1–16 non-space characters).');
  const description = metadata.description;
  required(typeof description === 'string' && description === description.trim().normalize('NFC')
    && Buffer.byteLength(description, 'utf8') >= 20 && Buffer.byteLength(description, 'utf8') <= 4096
    && (description.match(/[\p{L}\p{N}]/gu) ?? []).length >= 8,
  'Supply a trimmed NFC public description of 20–4096 UTF-8 bytes with at least eight letters or numbers.');
  required(typeof metadata.imagePath === 'string' && metadata.imagePath.length > 0, 'Supply the actual local image file path.');
  required(publicUri(metadata.imageUri, true), 'Supply a public HTTPS/IPFS/Arweave image URI matching the actual image.');
  required(publicUri(metadata.website), 'Supply the public HTTPS website.');
  required(config.publication?.websiteAccess !== 'private',
    'The configured website is still a private preview; publish and verify public access before using it in the launch package.');
  required(publicUri(metadata.x) && /^https:\/\/x\.com\/[A-Za-z0-9_]{1,64}$/.test(metadata.x), 'Supply the canonical public https://x.com/account profile, without a trailing slash.');
  const economics = config?.economics ?? {};
  required(Number.isInteger(economics.strategyFeeBps) && economics.strategyFeeBps > 0 && economics.strategyFeeBps <= 1000,
    'Choose strategyFeeBps between 1 and 1000; this excludes any platform and LP fee.');
  required(economics.saleMultiplierBps === 11000, 'This template requires saleMultiplierBps 11000 (1.1× recorded acquisition cost).');
  for (const field of ['initialLiquidityWei', 'maxLaunchValueWei', 'maxGasCostWei']) {
    required(typeof economics[field] === 'string' && UINT.test(economics[field]) && BigInt(economics[field]) < (1n << 256n),
      `Set economics.${field} explicitly as a uint256 decimal string; unknown cost is not zero.`);
  }
  if (typeof economics.initialLiquidityWei === 'string' && UINT.test(economics.initialLiquidityWei)
    && typeof economics.maxLaunchValueWei === 'string' && UINT.test(economics.maxLaunchValueWei)) {
    required(BigInt(economics.maxLaunchValueWei) >= BigInt(economics.initialLiquidityWei),
      'Launch value budget is below declared initial liquidity.');
  }
  const strategy = config?.strategy ?? {};
  if (strategy.acquisitionVenue === 'opensea') {
    required(['trusted-bot', 'bounded-spend'].includes(strategy.pricingPolicy?.mode), 'Pricing policy is not selected: choose the agreed trusted-bot policy or an explicitly capped legacy policy.');
    required(isAddress(strategy.purchaseBotAddress), 'Set strategy.purchaseBotAddress to the actual trusted purchase bot wallet; it is immutable and cannot be silently assigned to the creator.');
    if (strategy.pricingPolicy?.mode === 'bounded-spend') {
      required(typeof strategy.maxPurchasePriceWei === 'string' && UINT.test(strategy.maxPurchasePriceWei) && BigInt(strategy.maxPurchasePriceWei) > 0n
        && typeof strategy.maxSpendPerEpochWei === 'string' && UINT.test(strategy.maxSpendPerEpochWei) && BigInt(strategy.maxSpendPerEpochWei) > 0n,
        'The bounded-spend policy requires both fixed spending limits to be positive.');
    }
  }
  required(typeof config?.officialInputPath === 'string' && config.officialInputPath.length > 0,
    'An exact official input is missing: Ethereum CLI pack config or Robinhood Custom Launch Plan. No graph, salts, or deployment addresses are fabricated.');
  return blockers;
}

export function validateLiveCapabilities(chainId, capabilities, officialInput = null) {
  const blockers = [];
  if (chainId === 1) {
    if (String(capabilities?.chain?.id) !== '1') blockers.push('Capability response does not bind Ethereum.');
    if (capabilities?.profile?.productionLaunchAuthorized !== true) blockers.push('Ethereum production launch authorization is not active.');
    if (capabilities?.profile?.profileId !== 'programmable.direct-native-hook-graph.v1') blockers.push('Unrecognized Ethereum profile; integration must be reviewed.');
    if (capabilities?.profile?.profileVersion !== '3.6.0') blockers.push('Live Ethereum profile differs from the pinned 3.6.0 release; review before repacking.');
    if (capabilities?.programmableTradeFeePolicy?.policyHash !== 'sha256:5956cdeee628ba84dfa5214efd532011e59c202e4e1c1830b1eca279d58d79d3') blockers.push('Ethereum routed fee policy differs from the pinned release.');
    if (officialInput) {
      const version = officialInput.profileVersion ?? '3.3.0';
      if (!capabilities?.requestProfiles?.freshSubmissionExactVersions?.includes(version)) blockers.push('The official input profile is not admitted for fresh submissions.');
      if (officialInput.launchProfile?.profileRevision !== capabilities?.profile?.profileRevision) blockers.push('Ethereum profile revision changed.');
    }
  } else if (chainId === 4663) {
    if (String(capabilities?.chainId) !== '4663') blockers.push('Capability response does not bind Robinhood chain 4663.');
    for (const op of ['create', 'preflight']) {
      if (capabilities?.availability?.operations?.[op]?.state !== 'active') blockers.push(`Robinhood ${op} operation is not active.`);
    }
    if (officialInput && officialInput.manifestDigest !== capabilities.manifestDigest) blockers.push('Robinhood manifest changed: re-read the guide and repack with the current official packer.');
  } else blockers.push('Select a supported chain before live checks.');
  return blockers;
}

// Launch admission and Programmable onsite trading are distinct capabilities. Keep
// this result out of the source-packing blockers: a disabled trading service must
// be visible without claiming that it prohibits deployment or the independent
// Uniswap route implemented by the strategy website.
export function inspectPlatformTrading(capabilities) {
  const trading = capabilities?.onsiteTrading;
  const blockers = [];
  if (!trading) blockers.push('The platform did not report onsite trading availability.');
  else {
    if (trading.status === 'disabled') blockers.push(`Programmable onsite trading is disabled: ${trading.reasonCode ?? 'no reason provided'}.`);
    if (trading.descriptorPublicationActive !== true) blockers.push('Programmable trading descriptor publication is not active.');
    if (!trading.universalRouterExecutionProof || trading.universalRouterExecutionProof === 'required-not-established') {
      blockers.push('Exact Universal Router execution proof is not established in public capabilities.');
    }
  }
  return {
    scope: 'programmable-onsite-only',
    status: trading?.status ?? 'unknown', reasonCode: trading?.reasonCode ?? null,
    descriptorPublicationActive: trading?.descriptorPublicationActive === true,
    universalRouterExecutionProof: trading?.universalRouterExecutionProof ?? null,
    // A global capability response cannot establish this coin's own trade proof.
    coinTradingVerified: false, blockers,
    blocksIndependentWebsiteRoute: false,
  };
}

async function jsonGet(url) {
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Public discovery returned HTTP ${response.status}.`);
  return response.json();
}

async function rpcRead(url, method, params) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw new Error(`RPC read returned HTTP ${response.status}.`);
  const result = await response.json();
  if (result.error || !Object.hasOwn(result, 'result')) throw new Error(`RPC ${method} failed.`);
  return result.result;
}

export async function validateOfficialInput(input, chainId) {
  const route = ROUTES[chainId];
  if (!route) return ['Cannot validate official input before selecting a chain.'];
  const schemaFile = chainId === 1 && input?.profileVersion !== '3.6.0'
    ? 'programmable-ethereum-pack-config.v3.json' : route.schemaFile;
  const schemaBytes = await readFile(path.join(ROOT, 'config', 'schemas', schemaFile));
  const sources = JSON.parse(await readFile(path.join(ROOT, 'config', 'schemas', 'sources.json'), 'utf8'));
  const provenance = sources.sources.find((item) => item.file === schemaFile);
  if (!provenance || sha256(schemaBytes) !== provenance.sha256) throw new Error('Pinned official schema bytes differ from their recorded digest.');
  const { default: Ajv2020 } = await import('ajv/dist/2020.js');
  const { default: addFormats } = await import('ajv-formats');
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(JSON.parse(schemaBytes));
  if (validate(input)) return [];
  return validate.errors.map(({ instancePath, keyword, message }) => `Official schema ${instancePath || '/'} ${keyword}: ${message}`);
}

export async function prepare(configPath, options = {}) {
  const absoluteConfig = path.resolve(configPath);
  const root = path.dirname(absoluteConfig);
  const config = JSON.parse(await readFile(absoluteConfig, 'utf8'));
  const blockers = validateConfig(config);
  const report = {
    schemaVersion: 'claus.programmable-readiness-report.v1',
    checkedAt: new Date().toISOString(),
    chainId: config.chainId,
    route: ROUTES[config.chainId] ?? null,
    moduleCatalog: { newContributions: 'retired', reusableTemplate: true, catalogPublished: false },
    blockers,
    checks: { localConfiguration: false, officialSchema: false, publicCapabilities: false, collectionOnChain: false },
    safety: { audited: false, platformApproval: false, sourceRuntimeVerified: false, deployed: false },
    callsMade: { authenticatedApi: false, preflight: false, submit: false, wallet: false },
    officialInput: null,
    readyForOfficialPacking: false,
    readyForWallet: false,
    publicationStatus: { websiteAccess: config.publication?.websiteAccess ?? 'not-checked' },
    trading: inspectPlatformTrading(null),
    directWebsiteTrading: config.chainId === 1 ? {
      route: 'canonical-uniswap-v4-universal-router',
      requiresProgrammableTradingUi: false,
      productionVerified: false,
      verificationGuide: 'docs/WEBSITE-TRADING.md',
      remaining: 'Deploy and verify the exact strategy, bind the website to its actual runtime hashes, then verify the production trade route before enabling live mode.',
    } : null,
    credentials: {
      programmableApiKeyPresent: Boolean(process.env.PROGRAMMABLE_API_KEY),
      openSeaApiKeyPresent: Boolean(process.env.OPENSEA_API_KEY),
      purchaseBotKeyPresent: Boolean(process.env.CLAUS_KEEPER_PRIVATE_KEY),
      // Presence is all this helper checks. It never emits key values,
      // authenticates them, or infers a wallet address from them.
      validated: false,
    },
    acquisitionPolicy: {
      venue: config.strategy?.acquisitionVenue ?? null,
      pricingPolicy: config.strategy?.pricingPolicy ?? null,
      purchaseBotAddress: config.strategy?.purchaseBotAddress ?? null,
      fixedPurchaseCeilingWei: config.strategy?.maxPurchasePriceWei === '0' ? null : config.strategy?.maxPurchasePriceWei ?? null,
      fixedEpochCeilingWei: config.strategy?.maxSpendPerEpochWei === '0' ? null : config.strategy?.maxSpendPerEpochWei ?? null,
      noFixedCeilings: config.strategy?.maxPurchasePriceWei === '0' && config.strategy?.maxSpendPerEpochWei === '0',
    },
  };
  if (config.metadata?.imagePath) {
    try { await access(path.resolve(root, config.metadata.imagePath)); }
    catch { blockers.push('The declared local image file is absent.'); }
  }
  report.checks.localConfiguration = blockers.length === 0;
  let input = null;
  if (config.officialInputPath && ROUTES[config.chainId]) {
    try {
      const file = path.resolve(root, config.officialInputPath);
      const bytes = await readFile(file);
      input = JSON.parse(bytes);
      const schemaErrors = await validateOfficialInput(input, config.chainId);
      blockers.push(...schemaErrors);
      report.checks.officialSchema = schemaErrors.length === 0;
      if (String(input.chainId) !== String(config.chainId)) blockers.push('Official input chain differs from the selected NFT/token chain.');
      const controller = config.chainId === 1 ? input.launchWallet : input.controller?.address;
      if (controller?.toLowerCase() !== config.launchWallet?.toLowerCase()) blockers.push('Official input controller differs from the review configuration.');
      if (config.chainId === 4663 && (input.admissionPolicy !== 'programmable.custom-launch-policy.provenance.v1'
        || !Array.isArray(input.feeObligations) || input.feeObligations.length !== 0 || input.publication?.visibility !== 'listed')) {
        blockers.push('New Robinhood plans must use the current open provenance policy, empty feeObligations, and listed visibility.');
      }
      report.officialInput = { path: file, sha256: sha256(bytes), bytes: bytes.length, kind: ROUTES[config.chainId].inputKind };
    } catch (error) { blockers.push(`Official input validation failed: ${error.message}`); }
  }
  if (options.live && ROUTES[config.chainId]) {
    try {
      const capabilities = await jsonGet(ROUTES[config.chainId].capabilities);
      const liveErrors = validateLiveCapabilities(config.chainId, capabilities, input);
      blockers.push(...liveErrors);
      report.checks.publicCapabilities = liveErrors.length === 0;
      report.live = { profile: capabilities.profile ?? null, manifestDigest: capabilities.manifestDigest ?? null, operations: capabilities.availability?.operations ?? null, serverTime: capabilities.serverTime ?? null };
      if (config.chainId === 1) report.trading = inspectPlatformTrading(capabilities);
    } catch (error) { blockers.push(`Live discovery unavailable: ${error.message}`); }
  }
  if (options.rpcEnv) {
    const rpc = process.env[options.rpcEnv];
    if (!rpc) blockers.push(`RPC environment variable ${options.rpcEnv} is not set.`);
    else if (isAddress(config.nftCollection?.address) && ROUTES[config.chainId]) {
      try {
        const network = BigInt(await rpcRead(rpc, 'eth_chainId', []));
        if (network !== BigInt(config.chainId)) blockers.push('RPC network differs from NFT/token chain; refusing cross-chain preparation.');
        else {
          const code = await rpcRead(rpc, 'eth_getCode', [config.nftCollection.address, 'latest']);
          if (typeof code !== 'string' || !/^0x[0-9a-fA-F]+$/.test(code) || /^0x0*$/.test(code)) blockers.push('No collection contract code was found on the selected chain.');
          else report.checks.collectionOnChain = true;
        }
      } catch { blockers.push('Read-only RPC verification failed; no collection deployment is assumed.'); }
    }
  }
  report.readyForOfficialPacking = blockers.length === 0 && report.checks.officialSchema;
  report.remaining = [
    'Bind the exact collection, strategy fee, oracle, marketplace and buyback route into compiled constructor arguments; this report does not prove that mapping.',
    'Compile and verify the exact graph, CREATE2 salts, hook permission bits, runtime immutable materialization, and initializer funding.',
    'Validate through the current official CLI/packer and authenticated platform preflight before submission.',
    'Verify live OpenSea fulfillment with the deployed adapter/treasury identities and a real API key; fixture responses do not establish hosted API access.',
    'Run real PoolManager and marketplace fork tests, review price-oracle and MEV assumptions, and obtain independent contract review.',
    'Bind and verify the independent direct Uniswap website route against the actual deployment before enabling public buying; Programmable onsite trading availability is a separate capability.',
    'Controller reviews funding and exact wallet transaction; after signing, verify finality, runtime source, indexing and the full trading flow.',
  ];
  return report;
}

function isAddress(value) { return typeof value === 'string' && ADDRESS.test(value) && !ZERO.test(value); }
function publicUri(value, asset = false) {
  try {
    const uri = new URL(value);
    const host = uri.hostname.toLowerCase();
    const nonPublic = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
      || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
      || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
      || host === '0.0.0.0' || host.startsWith('[');
    return !uri.username && !uri.password && !uri.hash && host && !nonPublic
      && (uri.protocol === 'https:' || (asset && ['ipfs:', 'ar:'].includes(uri.protocol)));
  } catch { return false; }
}
function sha256(bytes) { return `sha256:${createHash('sha256').update(bytes).digest('hex')}`; }

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/prepare-launch.mjs --config config/programmable.example.json [--live] [--rpc-env CLAUS_RPC_URL] [--out artifacts/launch-review.json] [--require-ready]\nOffline by default. Public GET discovery and optional read-only JSON-RPC only. No keys, preflight, submissions or transactions.');
    return;
  }
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--require-ready') options.requireReady = true;
    else if (['--config', '--out', '--rpc-env'].includes(arg)) {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${arg}.`);
      options[{ '--config': 'config', '--out': 'out', '--rpc-env': 'rpcEnv' }[arg]] = args[++i];
    } else throw new Error(`Unknown argument ${arg}.`);
  }
  if (options.rpcEnv && !/^[A-Z][A-Z0-9_]*$/.test(options.rpcEnv)) throw new Error('RPC environment variable name must be uppercase letters, numbers and underscores.');
  const report = await prepare(options.config ?? path.join(ROOT, 'config', 'programmable.example.json'), options);
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const output = path.resolve(options.out);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, bytes);
  }
  console.log(bytes.trim());
  if (options.requireReady && !report.readyForOfficialPacking) process.exitCode = 2;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
