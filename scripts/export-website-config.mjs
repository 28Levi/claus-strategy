#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as ethers from 'ethers';
import {verifyDeployment} from './keeper.mjs';
import {assertConfig,ROLES,verifyPublicDeployment,TREASURY_ABI} from '../website/dist/state.mjs';
import {verifyTradingDeployment} from '../website/dist/trading.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC_RPC='https://ethereum-rpc.publicnode.com';

// Whitelist public fields. Never serialize environment, RPC credentials,
// operator settings, API keys, or extra properties of a supplied manifest.
export function makePublicConfig(base,manifest,release){
 const config={
  schemaVersion:1,status:'live',chainId:1,tokenSymbol:'CLSTR',collection:base.collection,
  collectionUrl:base.collectionUrl,launchWallet:base.launchWallet,
  purchaseBot:manifest.acquisition?.purchaseBotAddress,
  contracts:Object.fromEntries(ROLES.map(role=>[role,{address:manifest.contracts?.[role]?.address,runtimeCodeHash:manifest.contracts?.[role]?.runtimeCodeHash}])),
  rpcUrl:PUBLIC_RPC,tradeUrl:null,sourceUrl:base.sourceUrl??null,
  firstTokenId:base.firstTokenId,tokenCount:base.tokenCount,feeBps:200,resaleBps:11000,
  pricingPolicy:'trusted-bot',fixedPurchaseCapWei:'0',fixedDailyCapWei:'0',
  trading:{route:'uniswap-universal-router-v2',dependencies:Object.fromEntries(['router','quoter','permit2'].map(role=>[role,{address:release.dependencies[role].address,runtimeCodeHash:release.dependencies[role].runtimeCodeHash}]))},
 };
 if(manifest.chainId!==1||manifest.acquisition?.venue!=='opensea')throw new Error('An Ethereum OpenSea deployment manifest is required.');
 if(manifest.acquisition.pricingPolicy!=='trusted-bot')throw new Error('A trusted-bot acquisition manifest is required.');
 return assertConfig(config);
}

// Shared by the CLI and integration tests so the exact exported ABI and the
// complete keeper/public/trading verification path are exercised together.
export async function verifyPublicConfig(config,manifest,provider){
 const treasury=new ethers.Contract(config.contracts.treasury.address,TREASURY_ABI,provider);
 await verifyDeployment(provider,treasury,manifest);
 await verifyPublicDeployment(config,provider,ethers);
 await verifyTradingDeployment(config,provider);
 return{verifiedAt:new Date().toISOString(),verifiedBlock:await provider.getBlockNumber()};
}
async function main(){
 const args=process.argv.slice(2);const at=args.indexOf('--manifest');
 if(at<0||!args[at+1])throw new Error('Usage: node scripts/export-website-config.mjs --manifest deployment.json [--out website/dist/config.json]');
 const outputAt=args.indexOf('--out');const output=path.resolve(outputAt<0?path.join(ROOT,'website/dist/config.json'):args[outputAt+1]);
 const manifest=JSON.parse(await fs.readFile(path.resolve(args[at+1]),'utf8'));
 const base=JSON.parse(await fs.readFile(path.join(ROOT,'website/dist/config.json'),'utf8'));
 const release=JSON.parse(await fs.readFile(path.join(ROOT,'config/uniswap.ethereum-release.json'),'utf8'));
 const config=makePublicConfig(base,manifest,release);
 const provider=new ethers.JsonRpcProvider(process.env.CLAUS_RPC_URL??PUBLIC_RPC);
 try{
  Object.assign(config,await verifyPublicConfig(config,manifest,provider));
  await fs.mkdir(path.dirname(output),{recursive:true});
  const temporary=output+'.tmp';await fs.writeFile(temporary,JSON.stringify(config,null,2)+'\n');await fs.rename(temporary,output);
  console.log(JSON.stringify({written:output,chainId:1,verifiedBlock:config.verifiedBlock,token:config.contracts.token.address,route:config.trading.route,credentialsExported:false},null,2));
 }finally{provider.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.shortMessage??error.message);process.exitCode=1;});
