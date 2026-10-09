// The character is a link to the strategy, with pointer-responsive eyes.
// No wallet, token or treasury state participates in this effect.
const stage=document.querySelector('.character-stage');
const character=document.querySelector('.character-body');
const eyes=document.querySelector('.eyes');
const toggle=document.querySelector('#motion-toggle');
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
let paused=false,frame=0,pointer,blinkTimer;
const stopped=()=>paused||reduced.matches;
function motionState(){
 const off=stopped();document.documentElement.classList.toggle('motion-paused',off);toggle.disabled=reduced.matches;toggle.setAttribute('aria-pressed',String(off));toggle.textContent=reduced.matches?'Reduced motion':off?'Motion off':'Motion on';
 if(off){character.style.removeProperty('--lean');character.style.removeProperty('--look-x');character.style.removeProperty('--look-y');eyes.classList.remove('blink');clearTimeout(blinkTimer);}
}
toggle.addEventListener('click',()=>{paused=!paused;motionState();});reduced.addEventListener('change',motionState);motionState();
document.addEventListener('pointermove',event=>{
 if(stopped()||event.pointerType==='touch')return;pointer={x:event.clientX,y:event.clientY};if(frame)return;
 frame=requestAnimationFrame(()=>{frame=0;if(stopped()||document.hidden)return;const box=stage.getBoundingClientRect();if(box.bottom<0||box.top>innerHeight)return;
  const x=Math.max(-1,Math.min(1,(pointer.x-(box.left+box.width*.55))/(innerWidth*.5)));
  const y=Math.max(-1,Math.min(1,(pointer.y-(box.top+box.height*.58))/(innerHeight*.5)));
  // The portrait is upside down, so local eye movement is inverted.
  character.style.setProperty('--look-x',`${-x*13}px`);character.style.setProperty('--look-y',`${-y*10}px`);character.style.setProperty('--lean',`${x*1.5}deg`);
 });
},{passive:true});
document.querySelector('.character-link').addEventListener('pointerenter',()=>{
 if(stopped())return;eyes.classList.remove('blink');void eyes.offsetWidth;eyes.classList.add('blink');clearTimeout(blinkTimer);blinkTimer=setTimeout(()=>eyes.classList.remove('blink'),240);
});
