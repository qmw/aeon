// node tools/_wonly.mjs out.png [frames] — water + sky only, HUD hidden. Fast iteration.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,out='shots/_wonly.png',frames='30']=process.argv;
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.water&&window.camera,null,{timeout:120000});
const names=await p.evaluate(()=>{
  const keep=new Set(['water']);
  window.scene.children.forEach(o=>{ if(o.type==='Group'||o.type==='Mesh'){ if(!keep.has(o.name)) o.visible=false; }});
  document.querySelectorAll('#hud,.hud,#ui').forEach(e=>e.style.display='none');
  return window.scene.children.map(o=>o.name+':'+o.type+':'+o.visible);
});
const n=+frames+(await p.evaluate(()=>window.__frameCount||0));
await p.waitForFunction(k=>(window.__frameCount||0)>=k,n,{timeout:300000}).catch(()=>{});
await p.screenshot({path:out});
console.log(JSON.stringify({out,names,errs:errs.slice(0,6)}));
await b.close();
