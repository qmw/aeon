// water agent scratch: dump the band drivers themselves and measure their screen-space scale.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('PAGEERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
const wait=async n=>{const f=await p.evaluate(()=>window.__frameCount||0);
  await p.waitForFunction(k=>(window.__frameCount||0)>=k,f+n,{timeout:900000});};
await wait(14);
await p.evaluate(()=>{ window.fx.group.visible=false; });
for (const [tag,w] of [['chop',2],['grain',1],['norm',0]]) {
  await p.evaluate(v=>{ window.water.u.uK1.value.w=v; }, w);
  await wait(10);
  await p.screenshot({path:`shots/_wtap_${tag}.png`});
  console.log('captured', tag);
}
await b.close();
