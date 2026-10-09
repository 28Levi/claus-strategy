import solc from 'solc-seaport';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'artifacts/test-seaport/cache.json');
// Seaport's own current optimized build settings. Keep this separate from the
// strategy's solc 0.8.26 / 200-run production compilation and launch artifacts.
// https://github.com/ProjectOpenSea/seaport/blob/main/hardhat.config.ts
const settings = {
  optimizer: { enabled: true, runs: 4_294_967_295 }, viaIR: true, evmVersion: 'cancun',
  metadata: { bytecodeHash: 'none' },
  outputSelection: {
    'seaport-core/src/Seaport.sol': { Seaport: ['abi', 'evm.bytecode', 'evm.deployedBytecode'] },
    'seaport-core/src/conduit/ConduitController.sol': { ConduitController: ['abi', 'evm.bytecode', 'evm.deployedBytecode'] },
  },
};
let compiled;

export function compileSeaport() {
  if (compiled) return compiled;
  const sourceContent = name => fs.readFileSync(path.join(ROOT, 'node_modules', name), 'utf8');
  try {
    const cache = JSON.parse(fs.readFileSync(CACHE, 'utf8'));
    if (cache.compiler === solc.version() && JSON.stringify(cache.input.settings) === JSON.stringify(settings)
        && Object.entries(cache.input.sources).every(([name, source]) => source.content === sourceContent(name))
        && cache.artifacts.Seaport && cache.artifacts.ConduitController) {
      compiled = cache.artifacts;
      return compiled;
    }
  } catch { /* A missing or stale cache is rebuilt from pinned dependencies. */ }
  const sources = Object.fromEntries(Object.keys(settings.outputSelection).map(name => [name, {content: sourceContent(name)}]));
  const input = { language: 'Solidity', sources, settings };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import(name) {
    try {
      const content = sourceContent(name);
      sources[name] = {content};
      return {contents: content};
    } catch { return {error: `Missing Seaport test dependency: ${name}`}; }
  } }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifacts = {};
  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, c] of Object.entries(contracts)) {
      if (!c.evm?.bytecode?.object) continue;
      artifacts[contractName] = {
        contractName, sourceName, abi: c.abi, compiler: solc.version(),
        bytecode: `0x${c.evm.bytecode.object}`, deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
      };
      if (c.evm.deployedBytecode.object.length / 2 > 24_576) throw new Error(`${contractName} exceeds the EIP-170 runtime limit`);
    }
  }
  fs.mkdirSync(path.dirname(CACHE), {recursive: true});
  fs.writeFileSync(CACHE, JSON.stringify({compiler: solc.version(), input, artifacts}));
  compiled = artifacts;
  return compiled;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const artifact of Object.values(compileSeaport())) {
    console.log(`${artifact.contractName}: ${(artifact.deployedBytecode.length - 2) / 2} runtime bytes, Solidity ${artifact.compiler} (test dependency only)`);
  }
}
