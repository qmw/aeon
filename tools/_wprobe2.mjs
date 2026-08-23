import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=> (window.__frameCount||0)>=3,null,{timeout:120000}).catch(()=>{});
const out = await p.evaluate(()=>{
  const cam = window.camera || window.__camera;
  if(!cam) return {keys:Object.keys(window).filter(k=>/cam|scene|water|map/i.test(k))};
  const T = window.THREE;
  const res=[];
  const pts=[[1100,110],[1150,200],[1100,300],[1150,380],[900,540],[700,700],[1000,60]];
  for(const [sx,sy] of pts){
    const ndc = new T.Vector3((sx/1600)*2-1, -((sy/900)*2-1), 0.5).unproject(cam);
    const dir = ndc.sub(cam.position).normalize();
    const t = (0.10 - cam.position.y)/dir.y;
    const hit = cam.position.clone().add(dir.multiplyScalar(t));
    // world units per pixel: reproject a 1px offset
    const ndc2 = new T.Vector3(((sx+1)/1600)*2-1, -((sy/900)*2-1), 0.5).unproject(cam);
    const dir2 = ndc2.sub(cam.position).normalize();
    const t2 = (0.10 - cam.position.y)/dir2.y;
    const hit2 = cam.position.clone().add(dir2.multiplyScalar(t2));
    res.push({sx,sy,dist:+t.toFixed(1),px:+hit.distanceTo(hit2).toFixed(4),x:+hit.x.toFixed(1),z:+hit.z.toFixed(1)});
  }
  return {cam:[+cam.position.x.toFixed(1),+cam.position.y.toFixed(1),+cam.position.z.toFixed(1)], fov:cam.fov, res,
          mapw: window.map?.w, maph: window.map?.h, sun: window.sky? [ +window.sky.sunDir.x.toFixed(3),+window.sky.sunDir.y.toFixed(3),+window.sky.sunDir.z.toFixed(3)]:null};
});
console.log(JSON.stringify(out,null,1));
await b.close();
