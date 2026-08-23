// units agent: what building instance is under a screen point? node tools/_uwhat.mjs x y [r]
import { chromium } from 'playwright';
const [, , qx = '1085', qy = '705', rad = '70'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && window.units.cities.length && (window.__frameCount || 0) >= 6, null, { timeout: 300000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(([qx, qy, rad]) => {
  const U = window.units, C = window.camera, W = innerWidth, H = innerHeight;
  const V = U.group.position.constructor;
  const prj = (x, y, z) => { const v = new V(x, y, z); v.project(C); return [(v.x * .5 + .5) * W, (.5 - v.y * .5) * H]; };
  const hits = [];
  for (const [type, list] of U.builds) {
    const d = U.bdim.get(type);
    for (const b of list) {
      const q = b.p; if (!q) continue;
      const [x, y] = prj(q[0], q[1] + (d ? d.h * q[4] * 0.5 : 0.2), q[2]);
      const dd = Math.hypot(x - qx, y - qy);
      if (dd < rad) hits.push({ type, px: [Math.round(x), Math.round(y)], d: Math.round(dd), h: d ? +(d.h * q[4]).toFixed(2) : 0, city: b.c?.name });
    }
  }
  hits.sort((a, b) => a.d - b.d);
  return hits.slice(0, 12);
}, [+qx, +qy, +rad])));
await b.close();
