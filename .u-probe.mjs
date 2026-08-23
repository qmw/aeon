import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:600,height:400}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:120000});
await p.waitForTimeout(7000);
console.log(JSON.stringify(await p.evaluate(()=>{
  const U=window.units,T=window.terrain,out=[];
  for(const u of [...U.units.values()].slice(0,6)){
    const f=0.26, s=[U.y(u.x,u.z),U.y(u.x-f,u.z),U.y(u.x+f,u.z),U.y(u.x,u.z-f),U.y(u.x,u.z+f),U.y(u.x-0.5,u.z),U.y(u.x+0.5,u.z)];
    out.push({id:u.id,t:u.type,uy:+u.y.toFixed(3),samples:s.map(v=>+v.toFixed(3))});
  }
  return {out, decalCount:U.decals.mesh.count, flagCount:U.flags.mesh.count, sun:U.sunDir.toArray().map(v=>+v.toFixed(2))};
}),null,1));
await b.close();
