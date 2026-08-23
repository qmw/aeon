// units agent scratch: the SHIPPED framing, units only, flat background — silhouette read.
import { chromium } from 'playwright';
const [,,out='/tmp/uiso.png']=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=4,null,{timeout:300000}).catch(()=>{});
await p.evaluate(()=>{
  const U=window.units;
  setInterval(()=>{
    for(const o of window.scene.children) if(!o.isLight&&o!==U.group) o.visible=false;
    for(const [,e] of U.bmesh) e.mesh.visible=false;
    U.shadows.mesh.visible=false; U.decals.mesh.visible=false;
    if(U.roadMesh)U.roadMesh.visible=false;
    for(const c of U.cities) if(c.plate) c.plate.visible=false;
    document.querySelectorAll('#hud,.hud').forEach(e=>e.style.display='none');
  },40);
});
const f0=await p.evaluate(()=>window.__frameCount||0);
await p.waitForFunction(n=>(window.__frameCount||0)>=n,f0+30,{timeout:300000}).catch(()=>{});
await p.screenshot({path:out});
console.log(out);
await b.close();
