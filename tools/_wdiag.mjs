// water agent scratch: toggle overlay groups, converge, measure a water box.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
const wait=async n=>{const f=await p.evaluate(()=>window.__frameCount||0); await p.waitForFunction(k=>(window.__frameCount||0)>=k,f+n,{timeout:300000});};
await wait(22);
for(const cfg of ['all','nofx','nofxgrid']){
  await p.evaluate(c=>{
    window.fx && (window.fx.group.visible = c==='all');
    const g=window.scene.children.find(o=>o.name==='grid');
    if(g) g.visible = c!=='nofxgrid';
  },cfg);
  await wait(20);
  await p.screenshot({path:`shots/_wd_${cfg}.png`});
  console.log(cfg);
}
await b.close();
