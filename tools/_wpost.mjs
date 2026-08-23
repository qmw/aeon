// water agent scratch: how much of the sea's band energy does post.js's aerial flatten eat?
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
const wait=async n=>{const f=await p.evaluate(()=>window.__frameCount||0); await p.waitForFunction(k=>(window.__frameCount||0)>=k,f+n,{timeout:300000});};
await wait(22);
await p.screenshot({path:'shots/_wp_on.png'});
console.log(JSON.stringify(await p.evaluate(()=>{
  const u = window.post?._mPresent?.uniforms; if(!u) return {err:'no present uniforms', keys:Object.keys(window.post||{})};
  const before = {cutHF:u.uCutHF.value, cutMID:u.uCutMID.value, blur:u.uBlur.value, flatMip:u.uFlatMip.value};
  u.uCutHF.value=0; u.uCutMID.value=0; u.uBlur.value=0;
  window.fx.group.visible=false;
  return before;
})));
await wait(20);
await p.screenshot({path:'shots/_wp_off.png'});
await b.close();
