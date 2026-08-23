// Unproject a screen point onto the water plane and dump the tile + field values around it.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,sx='1407',sy='327']=process.argv;
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.water&&window.camera&&(window.__frameCount||0)>2,null,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(async ([sx,sy])=>{
  const T=window.THREE, cam=window.camera, map=window.map;
  const hex=await import('/src/world/hex.js');
  const hit=(x,y)=>{ const r=new T.Raycaster(); r.setFromCamera(new T.Vector2(x/1600*2-1,-(y/900*2-1)),cam);
    const pl=new T.Plane(new T.Vector3(0,1,0),-0.10), o=new T.Vector3(); r.ray.intersectPlane(pl,o); return o; };
  const at=(x,y)=>{ const w=hit(x,y); if(!w) return null; const a=hex.worldToAxial(w.x,w.z); const t=map.get(a.q,a.r);
    return {sx:x,sy:y,wx:+w.x.toFixed(2),wz:+w.z.toFixed(2),q:t?.q,r:t?.r,biome:t?.biome,elev:+(t?.elev??0).toFixed(3),h:+(t?.height??0).toFixed(2),feat:t?.feature||null}; };
  const rows=[];
  for(const d of [[0,0],[-90,0],[90,0],[0,-60],[0,60],[-140,-60],[140,60]]) rows.push(at(+sx+d[0],+sy+d[1]));
  return {rows, sd: rows.map(r=>r&&+window.water.submergedAt(r.wx,r.wz).toFixed(2))};
},[+sx,+sy]),null,0));
await b.close();
