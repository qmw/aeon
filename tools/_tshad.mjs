import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:800,height:450}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=6,null,{timeout:300000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(()=>{
  const s=window.scene; let sun=null; s.traverse(o=>{if(o.isDirectionalLight&&o.castShadow)sun=o;});
  const c=sun.shadow.camera;
  const lights=[]; s.traverse(o=>{if(o.isLight)lights.push({t:o.type,i:o.intensity,cs:!!o.castShadow});});
  let recv=0,cast=0,tot=0; window.terrain.group.traverse(o=>{if(o.isMesh){tot++;if(o.receiveShadow)recv++;if(o.castShadow)cast++;}});
  return {sun:{pos:sun.position.toArray().map(x=>+x.toFixed(2)),i:+sun.intensity.toFixed(2),
    box:[c.left,c.right,c.bottom,c.top,c.near,c.far].map(x=>+x.toFixed(1)),bias:sun.shadow.bias,nb:+sun.shadow.normalBias.toFixed(4),map:sun.shadow.mapSize.toArray()},
    lights, terrainMeshes:{tot,recv,cast}, cam:window.camera.position.toArray().map(x=>+x.toFixed(1)),
    toneMapping:window.renderer.toneMapping, shadowsEnabled:window.renderer.shadowMap.enabled};
})));
await b.close();
