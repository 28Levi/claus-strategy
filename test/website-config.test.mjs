import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';
import {makePublicConfig} from '../scripts/export-website-config.mjs';
const base=JSON.parse(await fs.readFile(new URL('../website/dist/config.json',import.meta.url),'utf8'));
const release=JSON.parse(await fs.readFile(new URL('../config/uniswap.ethereum-release.json',import.meta.url),'utf8'));
const sample=JSON.parse(await fs.readFile(new URL('../config/deployment.example.json',import.meta.url),'utf8'));
test('website export refuses an undeployed template and never copies secret manifest fields',()=>{
 assert.throws(()=>makePublicConfig(base,sample,release),/purchase bot|Unverified/);
 const manifest=structuredClone(sample);manifest.acquisition.purchaseBotAddress=base.purchaseBot;
 for(const entry of Object.values(manifest.contracts)){entry.address??='0x1111111111111111111111111111111111111111';entry.runtimeCodeHash??='0x'+'11'.repeat(32);entry.privateKey='DO_NOT_EXPORT';}
 manifest.operator.apiKey='DO_NOT_EXPORT';manifest.rpcUrl='https://private.example/DO_NOT_EXPORT';manifest.secret='DO_NOT_EXPORT';
 const publicConfig=makePublicConfig(base,manifest,release);
 assert.equal(publicConfig.status,'live');assert.equal(JSON.stringify(publicConfig).includes('DO_NOT_EXPORT'),false);
 assert.equal(publicConfig.rpcUrl,'https://ethereum-rpc.publicnode.com');assert.equal(publicConfig.trading.dependencies.router.address,release.dependencies.router.address);
 assert.throws(()=>makePublicConfig(base,{...manifest,chainId:31337},release),/Ethereum/);
 assert.throws(()=>makePublicConfig(base,{...manifest,acquisition:{...manifest.acquisition,pricingPolicy:'oracle'}},release),/trusted-bot/);
});
