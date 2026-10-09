import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const errors=[],results=[];
const output=new URL('../../artifacts/website/',import.meta.url);
await fs.mkdir(output,{recursive:true});
async function unobstructed(page,selector,label){
 const locator=page.locator(selector).first();await locator.evaluate(node=>node.scrollIntoView({block:'center',behavior:'instant'}));
 const check=await locator.evaluate(node=>{const r=node.getBoundingClientRect();const x=Math.max(1,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(1,Math.min(innerHeight-1,r.top+r.height/2));const top=document.elementFromPoint(x,y);return{ok:top===node||node.contains(top),top:top?.outerHTML.slice(0,120),rect:{x:r.x,y:r.y,width:r.width,height:r.height}};});
 assert.equal(check.ok,true,`${label} is obstructed: ${JSON.stringify(check)}`);
}
try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>{window.walletRequests=[];window.ethereum={request:async request=>{window.walletRequests.push(request);throw new Error('Unexpected wallet request in character test');}};});
 await page.goto('http://127.0.0.1:4173',{waitUntil:'networkidle'});await page.evaluate(()=>document.fonts.ready);
 assert.equal(await page.getByRole('heading',{name:/^claus\s+strategy$/i,level:1}).count(),1);
 assert.equal(await page.locator('link[href="/play.css"],link[href="/styles.css"],script[src="/play.mjs"]').count(),0);
 assert.equal(await page.locator('.character-link').getAttribute('href'),'#loop');
 const blink=await page.evaluate(()=>{
  const eyes=document.querySelector('.eyes'),nodes=[...eyes.querySelectorAll('.eye')];
  const before=nodes.map(node=>{const box=node.getBoundingClientRect();return{width:box.width,height:box.height};});
  eyes.classList.add('blink');const animations=eyes.getAnimations({subtree:true});
  for(const animation of animations){animation.pause();animation.currentTime=100;}
  const during=nodes.map(node=>{const box=node.getBoundingClientRect(),cover=getComputedStyle(node),lid=getComputedStyle(node,'::after');return{width:box.width,height:box.height,cover:cover.backgroundColor,lid:lid.backgroundColor,transform:lid.transform};});
  return{before,during,animations:animations.length};
 });
 assert.equal(blink.animations,2,'Both eyes should have an eyelid animation');
 for(let i=0;i<2;i++){assert.equal(blink.during[i].width,blink.before[i].width,'Eye coverage must not shrink during a blink');assert.equal(blink.during[i].height,blink.before[i].height);assert.equal(blink.during[i].cover,'rgb(255, 242, 216)');assert.equal(blink.during[i].lid,'rgb(0, 0, 0)');assert.equal(blink.during[i].transform,'matrix(1, 0, 0, 1, 0, 0)');}
 await page.screenshot({path:new URL('sparse-blink-mask.png',output).pathname.replace(/^\/(\w:)/,'$1')});
 await page.evaluate(()=>document.querySelector('.eyes').classList.remove('blink'));
 await page.mouse.move(1350,550);
 await page.waitForFunction(()=>document.querySelector('.character-body').style.getPropertyValue('--look-x')!=='');
 await page.locator('#motion-toggle').click();assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('#motion-toggle').innerText(),'Motion off');
 assert.equal(await page.locator('.character-body').evaluate(node=>node.style.getPropertyValue('--look-x')),'');
 await page.mouse.move(200,400);assert.equal(await page.locator('.character-body').evaluate(node=>node.style.getPropertyValue('--look-x')),'');
 await page.locator('#motion-toggle').focus();await page.keyboard.press('Space');assert.equal(await page.locator('#motion-toggle').innerText(),'Motion on');
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#motion-toggle').disabled);
 assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'),'true');assert.equal(await page.locator('#motion-toggle').innerText(),'Reduced motion');
 await page.emulateMedia({reducedMotion:'no-preference'});await page.waitForFunction(()=>!document.querySelector('#motion-toggle').disabled);
 assert.equal(await page.locator('#motion-toggle').getAttribute('aria-pressed'),'false');
 await page.locator('.character-link').focus();await page.keyboard.press('Enter');assert.match(page.url(),/#loop$/);
 assert.equal(await page.locator('.flow-steps>li').count(),4);
 assert.match(await page.locator('.flow-steps').innerText(),/Buy\. Sell\.[\s\S]*Buy a Claus\.[\s\S]*Offer it for sale\.[\s\S]*Buy back\. Burn\./);
 results.push('Opaque eye coverage during blinking, character pointer response, native keyboard link, motion pause/resume and changing OS motion preference passed; four strategy steps remain readable.');
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:width<800?900:1000});await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Horizontal overflow at ${width}px`);
  const title=await page.locator('#hero-title').boundingBox();assert.ok(title.x>=0&&title.x+title.width<=width,`Title clipped at ${width}px`);
  await unobstructed(page,'.nav-actions .trade-trigger',`${width}px Buy button`);
  if(width<=800)await unobstructed(page,'.menu-button',`${width}px mobile menu`);
  await unobstructed(page,'.scroll-link',`${width}px strategy link`);
  await unobstructed(page,'#motion-toggle',`${width}px motion control`);
  await unobstructed(page,'.calculation>summary',`${width}px calculator disclosure`);
  await page.locator('.calculation>summary').focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('#example-price').isVisible(),true);
  await unobstructed(page,'#example-price',`${width}px calculator input`);
  await page.locator('.calculation>summary').click();
  await unobstructed(page,'#inventory-tab',`${width}px treasury tab`);
  await unobstructed(page,'.faq summary',`${width}px native risk disclosure`);
  await unobstructed(page,'#contracts-trigger',`${width}px contract information`);
  for(const selector of ['.hero-copy>p','.flow-copy p','.empty-state p','.footer-status p']){
   for(const node of await page.locator(selector).all())if(await node.isVisible()){const box=await node.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+.5,`${selector} text clipped at ${width}px`);}
  }
  await page.evaluate(()=>scrollTo({top:0,behavior:'instant'}));
  await page.screenshot({path:new URL(`sparse-${width}.png`,output).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});
  await page.screenshot({path:new URL(`sparse-hero-${width}.png`,output).pathname.replace(/^\/(\w:)/,'$1')});
  results.push(`${width}px: title/body copy within viewport; no horizontal overflow; buy, menu, strategy, motion, calculator, treasury and contract controls unobstructed.`);
 }
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.querySelector('#motion-toggle').disabled);
 await page.mouse.move(100,350);
 assert.equal(await page.locator('.character-body').evaluate(node=>getComputedStyle(node).transform),'none');
 assert.equal(await page.locator('.eye i').first().evaluate(node=>getComputedStyle(node).transitionDuration),'0s');
 assert.equal(await page.locator('.eye').first().evaluate(node=>getComputedStyle(node).animationName),'none');
 assert.equal(await page.evaluate(()=>window.walletRequests.length),0);assert.deepEqual(errors,[]);
 const proof={checkedAt:new Date().toISOString(),design:'sparse character-led layout; character.mjs and site.css',results,pageErrors:errors,liveWalletTransactions:false};
 await fs.writeFile(new URL('play-browser-proof.json',output),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof,null,2));
}finally{await browser.close();}
