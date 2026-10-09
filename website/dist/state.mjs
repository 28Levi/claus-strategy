export const COLLECTION='0x80396c7131159eB92E7E84839e51C9887A7A95d9';
export const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
export const HASH=/^0x[0-9a-fA-F]{64}$/;
export const ROLES=['treasury','token','hook','market','initializer','poolManager','collection','seaport','conduitController','allowedZone'];
export function assertConfig(config){
  if(config?.schemaVersion!==1||config.chainId!==1||!['prelaunch','live'].includes(config.status))throw new Error('Unsupported website configuration.');
  if(config.collection?.toLowerCase()!==COLLECTION.toLowerCase())throw new Error('Wrong NFT collection.');
  if(config.feeBps!==200||config.resaleBps!==11000||config.pricingPolicy!=='trusted-bot')throw new Error('Unexpected strategy policy.');
  if(config.fixedPurchaseCapWei!=='0'||config.fixedDailyCapWei!=='0')throw new Error('Expected the uncapped strategy.');
  if(!Number.isInteger(config.firstTokenId)||!Number.isInteger(config.tokenCount)||config.tokenCount<1||config.tokenCount>512)throw new Error('Invalid collection range.');
  if(!ADDRESS.test(config.purchaseBot??''))throw new Error('Missing purchase bot.');
  if(config.status==='live'){
    for(const role of ROLES){const c=config.contracts?.[role];if(!ADDRESS.test(c?.address??'')||!HASH.test(c?.runtimeCodeHash??''))throw new Error(`Unverified ${role} address.`);}
    if(!httpsUrl(config.rpcUrl))throw new Error('A public HTTPS Ethereum RPC is required.');
    if(config.contracts.collection.address.toLowerCase()!==config.collection.toLowerCase())throw new Error('Collection binding mismatch.');
  }
  return config;
}
export function httpsUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u:null;}catch{return null;}}
export function parseAmount(value){
  if(typeof value!=='string'||!/^\d{1,18}(?:\.\d{1,18})?$/.test(value))throw new Error('Enter a positive amount with up to 18 decimals.');
  const [whole,decimal='']=value.split('.');const wei=BigInt(whole)*10n**18n+BigInt(decimal.padEnd(18,'0'));
  if(wei<=0n)throw new Error('Amount must be greater than zero.');return wei;
}
export function formatAmount(value,places=4){const amount=BigInt(value);const whole=amount/10n**18n;const fractional=(amount%10n**18n).toString().padStart(18,'0').slice(0,places).replace(/0+$/,'');return `${whole}${fractional?'.'+fractional:''}`;}
export function exampleAmounts(value){const cost=parseAmount(value);return{cost,ask:(cost*11000n+9999n)/10000n,taxableVolume:cost*50n};}
export function shortAddress(value){return ADDRESS.test(value??'')?`${value.slice(0,6)}…${value.slice(-4)}`:'Not deployed';}
export function explorerAddress(address){if(!ADDRESS.test(address))throw new Error('Invalid address');return `https://etherscan.io/address/${address}`;}
export function explorerTransaction(hash){if(!HASH.test(hash))throw new Error('Invalid transaction');return `https://etherscan.io/tx/${hash}`;}
export function collectionImage(id){if(!Number.isInteger(id)||id<1||id>300)throw new Error('Invalid NFT');return `https://claus.si/assets/nfts/png/${String(id).padStart(3,'0')}.png`;}

export const TREASURY_ABI=[
 'function token() view returns(address)','function collection() view returns(address)','function market() view returns(address)','function hook() view returns(address)','function initializer() view returns(address)',
 'function acquisitionBalance() view returns(uint256)','function buybackBalance() view returns(uint256)','function inventoryCount() view returns(uint256)','function totalTokensBurned() view returns(uint256)',
 'function firstTokenId() view returns(uint256)','function tokenCount() view returns(uint256)','function maxPurchasePrice() view returns(uint256)','function maxSpendPerEpoch() view returns(uint256)',
 'function positions(uint256) view returns(uint256 cost,uint256 ask)','function buyNFT(uint256,address) payable',
 'event NFTPurchased(uint256 indexed tokenId,address indexed seller,uint256 cost,uint256 ask)',
 'event NFTSold(uint256 indexed tokenId,address indexed buyer,address indexed recipient,uint256 proceeds)',
 'event BuybackBurned(uint256 ethSpent,uint256 tokensBurned)',
];
export async function verifyPublicDeployment(config,provider,ethers){
  assertConfig(config);if(config.status!=='live')throw new Error('The strategy is not deployed.');
  const [network,chainId]=await Promise.all([provider.getNetwork(),provider.send('eth_chainId',[])]);
  if(network.chainId!==1n||BigInt(chainId)!==1n)throw new Error('Ethereum mainnet is required.');
  for(const role of ROLES){const binding=config.contracts[role];const code=await provider.getCode(binding.address);if(code==='0x'||ethers.keccak256(code).toLowerCase()!==binding.runtimeCodeHash.toLowerCase())throw new Error(`Contract verification failed: ${role}.`);}
  const treasury=new ethers.Contract(config.contracts.treasury.address,TREASURY_ABI,provider);
  for(const role of ['token','collection','market','hook','initializer'])if((await treasury[role]()).toLowerCase()!==config.contracts[role].address.toLowerCase())throw new Error(`${role} binding changed.`);
  if(await treasury.maxPurchasePrice()!==0n||await treasury.maxSpendPerEpoch()!==0n)throw new Error('Unexpected purchase ceiling.');
  if(await treasury.firstTokenId()!==BigInt(config.firstTokenId)||await treasury.tokenCount()!==BigInt(config.tokenCount))throw new Error('Collection range mismatch.');
  const market=new ethers.Contract(config.contracts.market.address,['function purchaseBot() view returns(address)'],provider);
  if((await market.purchaseBot()).toLowerCase()!==config.purchaseBot.toLowerCase())throw new Error('Purchase bot mismatch.');
  return treasury;
}
export async function loadSnapshot(config,provider,ethers){
  const treasury=await verifyPublicDeployment(config,provider,ethers);
  const block=await provider.getBlockNumber();
  const [acquisitions,buybacks,inventoryCount,burned]=await Promise.all(['acquisitionBalance','buybackBalance','inventoryCount','totalTokensBurned'].map(name=>treasury[name]({blockTag:block})));
  const inventory=[];
  // Bounded batches; never treat failed reads as zero holdings.
  for(let start=config.firstTokenId;start<config.firstTokenId+config.tokenCount;start+=12){
    const ids=Array.from({length:Math.min(12,config.firstTokenId+config.tokenCount-start)},(_,i)=>start+i);
    const values=await Promise.all(ids.map(id=>treasury.positions(id,{blockTag:block})));
    values.forEach((p,i)=>{if(p.ask>0n)inventory.push({id:ids[i],cost:p.cost,ask:p.ask});});
  }
  if(BigInt(inventory.length)!==inventoryCount)throw new Error('Inventory snapshot did not match on-chain accounting.');
  let activity=[],activityUnavailable=false;
  try{
    const from=Math.max(config.deploymentBlock??0,block-2000);
    const logs=await provider.getLogs({address:treasury.target,fromBlock:from,toBlock:block});
    activity=logs.map(log=>{try{const parsed=treasury.interface.parseLog(log);return parsed?{name:parsed.name,args:parsed.args,hash:log.transactionHash,block:log.blockNumber,index:log.index}:null;}catch{return null;}}).filter(e=>e&&['NFTPurchased','NFTSold','BuybackBurned'].includes(e.name)).sort((a,b)=>b.block-a.block||b.index-a.index).slice(0,20);
  }catch{activityUnavailable=true;}
  return{block,acquisitions,buybacks,inventoryCount,burned,inventory,activity,activityUnavailable};
}
