import {assertConfig,exampleAmounts,formatAmount,shortAddress,explorerAddress,explorerTransaction,collectionImage,TREASURY_ABI,verifyPublicDeployment,loadSnapshot} from './state.mjs';
const $=s=>document.querySelector(s);
let config,provider,ethers,verified=false,refreshing=false,selectedNft,tradeQuote,quoteGeneration=0,tradeBusy=false;
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function link(text,url){const node=element('a',text);node.href=url;node.target='_blank';node.rel='noopener noreferrer';return node;}
function message(text){const toast=$('#toast');toast.textContent=text;toast.hidden=false;clearTimeout(message.timer);message.timer=setTimeout(()=>toast.hidden=true,5000);}
function showDialog(selector){const dialog=$(selector);dialog.showModal();document.body.style.overflow='hidden';}
for(const dialog of document.querySelectorAll('dialog')){
 dialog.querySelector('.dialog-close').addEventListener('click',()=>dialog.close());
 dialog.addEventListener('close',()=>document.body.style.overflow='');
 dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
}
$('.menu-button').addEventListener('click',()=>{const button=$('.menu-button');const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',open?'Close navigation':'Open navigation');$('#navigation').classList.toggle('open',open);});
for(const anchor of $('#navigation').querySelectorAll('a'))anchor.addEventListener('click',()=>{if($('.menu-button').getAttribute('aria-expanded')==='true')$('.menu-button').click();});
const tabs=[...document.querySelectorAll('[role=tab]')];
function selectTab(tab){for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;$('#'+item.getAttribute('aria-controls')).hidden=!selected;}}
for(const tab of tabs){tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):tabs[(tabs.indexOf(tab)+1)%tabs.length];selectTab(next);next.focus();}});}
function updateExample(){try{const values=exampleAmounts($('#example-price').value);$('#example-ask').textContent=formatAmount(values.ask,8)+' ETH';$('#example-buyback').textContent=formatAmount(values.ask,8)+' ETH';$('#example-volume').textContent=formatAmount(values.taxableVolume,8)+' ETH';$('#example-price').setCustomValidity('');}catch(error){for(const selector of ['#example-ask','#example-buyback','#example-volume'])$(selector).textContent='—';$('#example-price').setCustomValidity(error.message);}}
$('#example-price').addEventListener('input',updateExample);
function showStatus(){
 if(config?.status==='live'){$('#status-title').textContent=verified?'Verified on Ethereum.':'Checking the deployment.';$('#status-copy').textContent=verified?'The strategy contracts match the published deployment bindings. Always check the destination in your wallet.':'Live data or contract verification is unavailable. Trading and NFT purchases remain disabled.';}
 showDialog('#status-dialog');
}
for(const button of document.querySelectorAll('.trade-trigger'))button.addEventListener('click',()=>{if(config?.status==='live'&&verified&&config.trading?.dependencies)showDialog('#trade-dialog');else showStatus();});
$('#contracts-trigger').addEventListener('click',()=>{
 const body=$('#status-details');body.replaceChildren();
 if(config?.status==='live'){for(const role of ['token','treasury','hook','market']){const row=element('div');row.append(element('span',role),link(shortAddress(config.contracts[role].address),explorerAddress(config.contracts[role].address)));body.append(row);}}
 else{const row=element('div');row.append(element('span','Strategy contracts'),element('b','Not deployed'));body.append(row);if(config?.launchWallet){const wallet=element('div');wallet.append(element('span','Launch & bot wallet'),link(shortAddress(config.launchWallet),explorerAddress(config.launchWallet)));body.append(wallet);}}
 showStatus();
});
function renderSnapshot(snapshot){
 $('#metric-acquisitions').textContent=formatAmount(snapshot.acquisitions)+' ETH';$('#metric-buybacks').textContent=formatAmount(snapshot.buybacks)+' ETH';$('#metric-inventory').textContent=String(snapshot.inventoryCount);$('#metric-burned').textContent=formatAmount(snapshot.burned,2);
 $('#inventory-count').textContent=String(snapshot.inventoryCount);$('#data-status').textContent='Verified on-chain';$('#data-note').textContent=`Ethereum block ${snapshot.block.toLocaleString()}. Activity shows up to 20 events from the most recent 2,000 blocks.`;
 const inventory=$('#inventory-grid');inventory.replaceChildren();$('#inventory-empty').hidden=snapshot.inventory.length>0;
 if(!snapshot.inventory.length){$('#inventory-empty h3').textContent='Waiting for the next Claus.';$('#inventory-empty p').textContent='The treasury currently holds no NFTs. Trading fees continue to fund future acquisitions.';}
 for(const nft of snapshot.inventory){const card=element('article',undefined,'nft-card');const img=element('img');img.src=collectionImage(nft.id);img.alt=`ContractClaus #${nft.id}`;img.loading='lazy';const button=element('button',`Buy for ${formatAmount(nft.ask,8)} ETH ↗`,'button');button.type='button';button.addEventListener('click',()=>{selectedNft=nft;$('#purchase-description').textContent=`ContractClaus #${nft.id} · current ask ${formatAmount(nft.ask,18)} ETH.`;$('#purchase-feedback').textContent='';showDialog('#purchase-dialog');});card.append(img,element('h3',`Claus #${String(nft.id).padStart(3,'0')}`),element('p',`Acquired for ${formatAmount(nft.cost,8)} ETH`),button);inventory.append(card);}
 const activity=$('#activity-list');activity.replaceChildren();$('#activity-empty').hidden=snapshot.activity.length>0;
 if(snapshot.activityUnavailable){$('#activity-empty h3').textContent='Activity is temporarily unavailable.';$('#activity-empty p').textContent='The RPC could not return recent events. Treasury balances above were verified separately.';}
 else if(!snapshot.activity.length){$('#activity-empty h3').textContent='No recent treasury events.';$('#activity-empty p').textContent='No purchases, resales or burns were returned in the most recent 2,000-block window.';}
 for(const event of snapshot.activity){const row=element('div',undefined,'activity-row');const title=event.name==='NFTPurchased'?`Bought Claus #${event.args.tokenId}`:event.name==='NFTSold'?`Sold Claus #${event.args.tokenId}`:`Burned ${formatAmount(event.args.tokensBurned,2)} CLSTR`;const label=element('span',title);label.append(element('small',`Block ${event.block.toLocaleString()}`));row.append(label,link('Transaction ↗',explorerTransaction(event.hash)));activity.append(row);}
}
async function refresh(){
 if(refreshing||config?.status!=='live')return;refreshing=true;$('#refresh-data').disabled=true;$('#data-status').textContent='Checking Ethereum…';
 try{ethers??=await import('./assets/ethers.min.js');provider??=new ethers.JsonRpcProvider(config.rpcUrl,1,{staticNetwork:true});const snapshot=await loadSnapshot(config,provider,ethers);verified=true;renderSnapshot(snapshot);$('#hero-note').textContent=`Verified Ethereum deployment · ${shortAddress(config.contracts.token.address)}`;$('#launch-status').textContent='Ethereum';$('#launch-strip-title').textContent='Trading is live.';$('#launch-strip-copy').textContent='The treasury follows its fixed custody rules. Connect an Ethereum wallet to trade or buy a held NFT.';}
 catch(error){verified=false;$('#data-status').textContent='Data unavailable';$('#data-note').textContent=`Live checks failed: ${error.shortMessage??error.message} Actions are disabled until verification succeeds.`;for(const id of ['metric-acquisitions','metric-buybacks','metric-inventory','metric-burned','inventory-count'])$('#'+id).textContent='—';$('#inventory-grid').replaceChildren();$('#inventory-empty').hidden=false;$('#inventory-empty h3').textContent='We couldn’t verify live data.';$('#inventory-empty p').textContent='No holdings or prices are being shown as current. Please refresh or check the verified contracts on Ethereum.';}
 finally{refreshing=false;$('#refresh-data').disabled=false;}
}
$('#refresh-data').addEventListener('click',refresh);
$('#purchase-confirm').addEventListener('click',async()=>{
 const feedback=$('#purchase-feedback'),button=$('#purchase-confirm'),selection=selectedNft;let wallet;button.disabled=true;
 try{
  if(!verified||!selection||config.status!=='live')throw new Error('A verified live treasury is required.');
  if(!window.ethereum)throw new Error('Open this page in an Ethereum wallet browser or install a wallet extension.');
  await verifyPublicDeployment(config,provider,ethers);
  await window.ethereum.request({method:'eth_requestAccounts'});
  const chain=await window.ethereum.request({method:'eth_chainId'});if(BigInt(chain)!==1n)await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x1'}]});
  wallet=new ethers.BrowserProvider(window.ethereum);await verifyPublicDeployment(config,wallet,ethers);
  const signer=await wallet.getSigner();const treasury=new ethers.Contract(config.contracts.treasury.address,TREASURY_ABI,signer);const position=await treasury.positions(selection.id);
  if(position.ask!==selection.ask||position.ask===0n)throw new Error('This ask changed or the NFT has sold. Refresh the treasury.');
  await treasury.buyNFT.staticCall(selection.id,await signer.getAddress(),{value:position.ask});
  feedback.textContent=`Confirm ${formatAmount(position.ask,18)} ETH plus gas in your wallet.`;
  const transaction=await treasury.buyNFT(selection.id,await signer.getAddress(),{value:position.ask});feedback.replaceChildren(link('Transaction submitted. View on Ethereum ↗',explorerTransaction(transaction.hash)));
  const receipt=await transaction.wait();if(receipt.status!==1)throw new Error('Purchase did not complete.');feedback.replaceChildren(link('NFT purchase confirmed ↗',explorerTransaction(transaction.hash)));await refresh();
 }catch(error){feedback.textContent=error.code==='ACTION_REJECTED'||error.code===4001?'Wallet request cancelled.':error.shortMessage??error.message;}finally{wallet?.destroy();button.disabled=false;}
});
function invalidateQuote(){quoteGeneration++;$('#trade-quote').hidden=true;tradeQuote=null;if(!tradeBusy)$('#trade-feedback').textContent='Request a fresh quote for this amount.';}
for(const radio of document.querySelectorAll('[name=direction]'))radio.addEventListener('change',()=>{$('#trade-currency').textContent=radio.value==='buy'?'ETH':'CLSTR';invalidateQuote();});
$('#trade-amount').addEventListener('input',invalidateQuote);
$('#trade-form').addEventListener('submit',async event=>{
 event.preventDefault();if(tradeBusy)return;const generation=++quoteGeneration,button=$('#trade-form button[type=submit]');button.disabled=true;$('#trade-feedback').textContent='Checking the pool and current quote…';$('#trade-quote').hidden=true;tradeQuote=null;
 try{
  if(!verified||config.status!=='live')throw new Error('Trading requires a verified live deployment.');
  const direction=$('[name=direction]:checked').value,amount=$('#trade-amount').value;
  const trading=await import('./trading.mjs');const quoted=await trading.quoteTrade({config,direction,amount,slippageBps:100});
  if(generation!==quoteGeneration||!verified)return;tradeQuote=quoted;
  const output=direction==='buy'?'CLSTR':'ETH';const area=$('#trade-quote');area.replaceChildren();area.append(element('p',`Estimated received: ${formatAmount(quoted.amountOutWei,8)} ${output}`),element('p',`Minimum received: ${formatAmount(quoted.minOutWei,8)} ${output}`));const confirm=element('button','Connect & confirm in wallet ↗','button black');confirm.type='button';
  confirm.addEventListener('click',async()=>{
   if(tradeBusy)return;
   const controls=[...$('#trade-form').querySelectorAll('input,button')];
   try{
    if(!verified||generation!==quoteGeneration||tradeQuote!==quoted||$('#trade-amount').value!==amount||$('[name=direction]:checked').value!==direction)throw new Error('This quote is no longer current. Request a fresh quote.');
    if(!window.ethereum)throw new Error('Open this page in an Ethereum wallet browser or install a wallet extension.');
    tradeBusy=true;confirm.disabled=true;for(const control of controls)control.disabled=true;
    const result=await trading.executeTrade({config,ethereum:window.ethereum,quote:quoted,onStatus:text=>$('#trade-feedback').textContent=text});const hash=result.hash??result.transactionHash??result.receipt?.hash;
    $('#trade-feedback').replaceChildren(hash?link('Trade confirmed on Ethereum ↗',explorerTransaction(hash)):element('span','Trade completed.'));tradeQuote=null;area.hidden=true;quoteGeneration++;await refresh();
   }catch(error){$('#trade-feedback').textContent=error.code==='ACTION_REJECTED'||error.code===4001?'Wallet request cancelled.':error.shortMessage??error.message;}
   finally{tradeBusy=false;confirm.disabled=false;for(const control of controls)control.disabled=false;}
  });
  area.append(confirm);area.hidden=false;$('#trade-feedback').textContent=direction==='sell'?'Selling may require exact-amount token and Permit2 approvals before the swap.':'Review the minimum received before confirming in your wallet.';
 }catch(error){if(generation===quoteGeneration)$('#trade-feedback').textContent=error.shortMessage??error.message;}finally{if(!tradeBusy)button.disabled=false;}
});
try{const response=await fetch('/config.json',{cache:'no-store'});if(!response.ok)throw new Error('Website configuration is unavailable.');config=assertConfig(await response.json());if(config.status==='live'){$('#refresh-data').hidden=false;await refresh();}}
catch(error){$('#hero-note').textContent='Configuration unavailable. Trading is disabled.';$('#data-status').textContent='Configuration unavailable';$('#data-note').textContent=error.message;}
updateExample();
