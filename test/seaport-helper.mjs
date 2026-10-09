import { ZeroAddress, ZeroHash, toBeHex } from 'ethers';
import { deploy, tx, E, chain, treasuryConfig } from './helper.mjs';

export const orderTypes = {
  OfferItem: [{name:'itemType',type:'uint8'},{name:'token',type:'address'},{name:'identifierOrCriteria',type:'uint256'},{name:'startAmount',type:'uint256'},{name:'endAmount',type:'uint256'}],
  ConsiderationItem: [{name:'itemType',type:'uint8'},{name:'token',type:'address'},{name:'identifierOrCriteria',type:'uint256'},{name:'startAmount',type:'uint256'},{name:'endAmount',type:'uint256'},{name:'recipient',type:'address'}],
  OrderComponents: [{name:'offerer',type:'address'},{name:'zone',type:'address'},{name:'offer',type:'OfferItem[]'},{name:'consideration',type:'ConsiderationItem[]'},{name:'orderType',type:'uint8'},{name:'startTime',type:'uint256'},{name:'endTime',type:'uint256'},{name:'zoneHash',type:'bytes32'},{name:'salt',type:'uint256'},{name:'conduitKey',type:'bytes32'},{name:'counter',type:'uint256'}],
};

export async function deploySeaportMarket(admin, nft) {
  const controller = await deploy('ConduitController', admin);
  const seaport = await deploy('Seaport', admin, [controller.target]);
  const zone = await deploy('TestSeaportZone', admin, [seaport.target]);
  const market = await deploy('SeaportListingMarket', admin, [nft.target, seaport.target, controller.target, zone.target, await admin.getAddress()]);
  await tx(zone.setExpectedFulfiller(market.target));
  return {controller, seaport, zone, market};
}

export async function makeOrder(f, options = {}) {
  const id = options.id ?? 1n;
  const price = options.price ?? E('1.6');
  const fee = options.fee ?? E('0.04');
  if (options.mint !== false) await tx(f.nft.mint(f.addresses[1], id));
  await tx(f.nft.connect(f.seller).setApprovalForAll(options.operator ?? f.seaport.target, true));
  const now = BigInt((await f.provider.getBlock('latest')).timestamp);
  const item = {itemType:0,token:ZeroAddress,identifierOrCriteria:0,startAmount:price-fee,endAmount:price-fee,recipient:f.addresses[1]};
  const components = {
    offerer:f.addresses[1], zone:options.restricted ? f.zone.target : ZeroAddress,
    offer:[{itemType:2,token:f.nft.target,identifierOrCriteria:id,startAmount:1,endAmount:1}],
    consideration:[item, {...item,startAmount:fee,endAmount:fee,recipient:options.feeRecipient ?? f.addresses[5]}],
    orderType: options.restricted ? 2 : 0,
    startTime:now-1n,endTime:now+3600n,zoneHash:ZeroHash,salt:options.salt ?? id,
    conduitKey:options.conduitKey ?? ZeroHash,counter:await f.seaport.getCounter(f.addresses[1]),
    ...options.components,
  };
  const signature = await f.seller.signTypedData({name:'Seaport',version:'1.6',chainId:(await f.provider.getNetwork()).chainId,verifyingContract:f.seaport.target}, orderTypes, components);
  const order = {parameters:{...components,totalOriginalConsiderationItems:components.consideration.length},numerator:1,denominator:1,signature,extraData:options.restricted ? '0x1234' : '0x'};
  return {order,components,hash:await f.seaport.getOrderHash(components),id,price};
}

export async function seaportFixture(t, options = {}) {
  const c = await chain(t);
  const [admin,seller,buyer,attacker] = c.signers;
  const nft = await deploy('MockNFT',admin);
  const dependencies = await deploySeaportMarket(admin,nft);
  const token = await deploy('StrategyToken',admin,['Claus Strategy','CLSTR',E('1000000000'),c.addresses[0]]);
  const config = treasuryConfig({token:token.target,nft:nft.target,market:dependencies.market.target,initializer:c.addresses[0],maxPurchasePrice:E('1.6'),maxSpendPerEpoch:E('1.6'),...options.config});
  const treasury = await deploy('StrategyTreasury',admin,[config]);
  const executor = await deploy('MockExecutor',admin,[token.target,treasury.target]);
  await tx(token.transfer(executor.target,E('100000000')));
  await tx(treasury.initializeHook(executor.target));
  return {...c,admin,seller,buyer,attacker,nft,token,...dependencies,config,treasury,executor};
}

export async function createConduit(f) {
  const key = f.addresses[1].toLowerCase() + toBeHex(1,12).slice(2);
  await tx(f.controller.connect(f.seller).createConduit(key,f.addresses[1]));
  const [operator] = await f.controller.getConduit(key);
  await tx(f.controller.connect(f.seller).updateChannel(operator,f.seaport.target,true));
  return {conduitKey:key,operator};
}
