import solc from 'solc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let compiled;
function files(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory()
    ? files(path.join(dir, e.name)) : e.name.endsWith('.sol') ? [path.join(dir, e.name)] : []);
}

export function compile({ write = false } = {}) {
  if (compiled && !write) return compiled;
  const sources = {};
  for (const file of [...files(path.join(ROOT, 'contracts')), ...files(path.join(ROOT, 'test/contracts'))]) {
    sources[path.relative(ROOT, file).replaceAll('\\', '/')] = { content: fs.readFileSync(file, 'utf8') };
  }
  const input = {
    language: 'Solidity', sources,
    settings: {
      optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun',
      metadata: { bytecodeHash: 'none', appendCBOR: false, useLiteralContent: true },
      outputSelection: { '*': { '*': ['abi', 'metadata', 'evm.bytecode', 'evm.deployedBytecode', 'storageLayout'], '': ['ast'] } },
    },
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input), { import(name) {
    const candidates = [path.join(ROOT, name), path.join(ROOT, 'node_modules', name)];
    if (name.startsWith('solmate/')) candidates.push(path.join(ROOT, 'node_modules/@uniswap/v4-core/lib', name));
    const file = candidates.find(fs.existsSync);
    if (!file) return { error: `Missing dependency: ${name}` };
    const content = fs.readFileSync(file, 'utf8');
    sources[name] = { content };
    return { contents: content };
  } }));
  const errors = (output.errors ?? []).filter(e => e.severity === 'error');
  if (errors.length) throw new Error(errors.map(e => e.formattedMessage).join('\n'));
  const artifacts = {};
  for (const [sourceName, contracts] of Object.entries(output.contracts)) {
    for (const [contractName, c] of Object.entries(contracts)) {
      artifacts[contractName] = {
        contractName, sourceName, abi: c.abi,
        bytecode: `0x${c.evm.bytecode.object}`,
        deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
        immutableReferences: c.evm.deployedBytecode.immutableReferences,
        linkReferences: c.evm.bytecode.linkReferences,
        deployedLinkReferences: c.evm.deployedBytecode.linkReferences,
        storageLayout: c.storageLayout, metadata: c.metadata, compiler: solc.version(),
      };
      if (sourceName.startsWith('contracts/') && c.evm.deployedBytecode.object.length / 2 > 24576) {
        throw new Error(`${contractName} exceeds the EIP-170 runtime limit`);
      }
    }
  }
  compiled = { artifacts, input, output };
  if (write) {
    const dir = path.join(ROOT, 'artifacts');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, artifact] of Object.entries(artifacts)) {
      fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(artifact, null, 2));
    }
    fs.writeFileSync(path.join(dir, 'standard-input.json'), JSON.stringify(input, null, 2));
    fs.writeFileSync(path.join(dir, 'standard-output.json'), JSON.stringify(output));
  }
  return compiled;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { artifacts } = compile({ write: true });
  console.log(`Compiled ${Object.keys(artifacts).length} contracts with ${solc.version()} (Cancun, optimizer 200, viaIR).`);
  for (const a of Object.values(artifacts).filter(a => a.sourceName.startsWith('contracts/') && a.bytecode !== '0x')) {
    console.log(`${a.contractName}: ${(a.deployedBytecode.length - 2) / 2} runtime bytes`);
  }
}
