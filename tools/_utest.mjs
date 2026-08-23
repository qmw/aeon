import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors=[]; p.on('console',m=>{if(m.type()==='error')errors.push(m.text())}); p.on('pageerror',e=>errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(22000);
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units, out = {};
  U._owner = U.cities[0];
  let x = -400;
  for (const k of ['mine','quarry','pasture','grove','fish','farm']) {
    try { U._improve(k, x, -400, 0.3, Math.random); x += 4; } catch (e) { out[k] = 'ERR ' + e.message; }
  }
  U._owner = null;
  try { U._flushBuildings(); } catch (e) { out.flush = 'ERR ' + e.message; }
  const bl = {}; for (const [k,v] of U.builds) bl[k]=v.length;
  let tris=0; window.scene.traverse(o=>{ if(o.isMesh||o.isInstancedMesh){const g=o.geometry; if(g?.index) tris+=g.index.count/3*(o.count||1); else if(g?.attributes?.position) tris+=g.attributes.position.count/3*(o.count||1);} });
  let utris=0; U.group.traverse(o=>{ if(o.isMesh||o.isInstancedMesh){const g=o.geometry; if(g?.index) utris+=g.index.count/3*(o.count||1); else if(g?.attributes?.position) utris+=g.attributes.position.count/3*(o.count||1);} });
  out.builds = bl; out.sceneTris = Math.round(tris); out.unitTris = Math.round(utris);
  return out;
}), null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0,8)));
await b.close();
