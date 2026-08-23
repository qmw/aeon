import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil:'load', timeout:60000 });
await p.waitForTimeout(9000);
console.log(JSON.stringify(await p.evaluate(async () => {
  const T = window.THREE, cam = window.camera, map = window.map;
  const hex = await import('/src/world/hex.js');
  const out = [];
  for (const t of map.tiles) {
    if (t.height !== 0) continue;
    const w = hex.axialToWorld(t.q, t.r);
    const v = new T.Vector3(w.x, 0.1, w.z).project(cam);
    if (Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05 || v.z > 1) continue;
    out.push({ q:t.q, r:t.r, biome:t.biome, feat:t.feature, elev:+t.elev.toFixed(2),
      sx: Math.round((v.x*0.5+0.5)*1600), sy: Math.round((-v.y*0.5+0.5)*900) });
  }
  return { seaLevel: map.seaLevel, n: out.length, tiles: out };
}), null, 0));
await b.close();
