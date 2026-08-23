import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors=[]; p.on('console',m=>{if(m.type()==='error')errors.push(m.text())}); p.on('pageerror',e=>errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(22000);
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units, T = window.terrain, C = window.camera;
  const proj = (x,y,z)=>{ const v=new window.THREE.Vector3(x,y,z).project(C); return [Math.round((v.x*.5+.5)*1600), Math.round((.5-v.y*.5)*900), +v.z.toFixed(3)]; };
  const builds = {}; for (const [k,v] of U.builds) builds[k]=v.length;
  const units = [...U.units.values()].map(u=>({id:u.id,t:u.type,px:proj(u.x,u.y,u.z),y:+u.y.toFixed(3),terr:+T.heightAt(u.x,u.z).toFixed(3),plat:U._platAt.has(u.q*4096+u.r)}))
     .filter(u=>u.px[0]>-100&&u.px[0]<1700&&u.px[1]>-100&&u.px[1]<1000);
  const imps = [...U._impAt.entries()].map(([k,c])=>{const q=Math.floor(k/4096),r=k-q*4096;const p=window.map.get(q,r);return {q,r,c:c.name,b:p?.biome,res:p?.resource};});
  const info=window.renderer.info.render;
  return {builds, nImp:U._impAt.size, imps, units, contacts:U._contacts.length, roads:U.roads.length,
          tris:info.triangles, calls:info.calls, fps:window.__fps};
}), null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0,8)));
await b.close();
