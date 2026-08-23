import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 14, null, { timeout: 180000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const out = { mspf: window.__mspf, counts: {} };
  const T = window.__terrain;
  let tri = 0;
  T?.group.traverse(o => {
    if (!o.visible || !o.geometry) return;
    const g = o.geometry, n = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const c = o.isInstancedMesh ? o.count : 1;
    tri += n * c;
    if (n * c > 20000) out.counts[o.name] = Math.round(n * c);
  });
  out.terrainTris = Math.round(tri);
  return out;
})));
await b.close();
