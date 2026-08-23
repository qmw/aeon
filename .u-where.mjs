import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:900,height:500}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(7000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const U=window.units; if(!U) return {no:1};
  return {
    units:[...U.units.values()].map(u=>({id:u.id,t:u.type,q:u.q,r:u.r,x:+u.x.toFixed(2),z:+u.z.toFixed(2),y:+u.y.toFixed(2),sc:u.scale})),
    cities:U.cities.map(c=>({n:c.name,q:c.q,r:c.r,x:+c.x.toFixed(2),z:+c.z.toFixed(2),y:+c.y.toFixed(2),pop:c.pop,tier:c.tier})),
    draws:window.renderer.info.render.calls, tris:window.renderer.info.render.triangles, fps:window.__fps,
  };
}),null,1));
await b.close();
