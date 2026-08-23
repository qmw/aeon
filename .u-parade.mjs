// units agent: line every unit type up on one flat shelf and photograph it. Silhouette gate.
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const [,, out='shots/_zz_parade.png', dist='9', pitch='14', yaw='0', w='1600', h='500', idx='-1'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors=[]; p.on('pageerror', e=>errors.push(String(e)));
p.on('console', m=>{ if(m.type()==='error' && !/favicon|Failed to load/.test(m.text())) errors.push(m.text()); });
await p.goto('http://localhost:5173/', { waitUntil:'load', timeout:60000 });
await p.waitForTimeout(4200);
const info = await p.evaluate(([dist,pitch,yaw,idx]) => {
  const U = window.units, T = window.THREE;
  if (window.input) window.input.update = () => {};
  for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display = 'none';
  // find a flat run of land tiles
  const M = window.map, hx = (q,r)=>({x:1.5*q, z:Math.sqrt(3)*(r+q/2)});
  let best=null, bs=1e9;
  for (let r=6;r<M.h-6;r++) for (let q=6;q<M.w-10;q++) {
    let ok=true, hs=[];
    for (let k=0;k<9;k++){ const t=M.get(q, r+k); if(!t||t.height<=0.05||!/^(grass|plains|desert|tundra)$/.test(t.biome)||t.feature){ok=false;break;} hs.push(t.height); }
    if(!ok) continue;
    const v = Math.max(...hs)-Math.min(...hs);
    if (v<bs){bs=v;best={q,r};}
  }
  if (!best) return {err:'no flat run'};
  const types=['warrior','spearman','archer','horseman','settler','builder','catapult','trireme'];
  types.forEach((t,i)=>U.add({type:t, q:best.q, r:best.r+i, team:i%3, yaw:1.05}));
  const c0=hx(best.q,best.r), c1=hx(best.q,best.r+7);
  let cx=(c0.x+c1.x)/2, cz=(c0.z+c1.z)/2;
  if (idx>=0) { const t=hx(best.q,best.r+idx); cx=t.x; cz=t.z; }
  const gy=window.terrain.heightAt(cx,cz);
  const c=window.camera, py=pitch*Math.PI/180, ya=yaw*Math.PI/180;
  c.position.set(cx+Math.sin(ya)*Math.cos(py)*dist, gy+0.4+Math.sin(py)*dist, cz+Math.cos(ya)*Math.cos(py)*dist);
  c.lookAt(cx,gy+0.45,cz); c.near=0.1; c.fov=42; c.updateProjectionMatrix();
  return {best, flat:+bs.toFixed(3)};
}, [+dist,+pitch,+yaw,+idx]);
await p.waitForTimeout(2200);
await p.screenshot({ path: out });
console.log(JSON.stringify({out, bytes:statSync(out).size, ...info, errors:errors.slice(0,5)}));
await b.close();
