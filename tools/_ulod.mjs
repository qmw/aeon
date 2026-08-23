// units agent: what the LOD cut throws away at gameplay zoom. node tools/_ulod.mjs
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 4, null, { timeout: 240000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units, C = window.camera, W = innerWidth, H = innerHeight;
  const out = [];
  for (const u of U.units.values()) {
    const dist = Math.hypot(C.position.x - u.x, C.position.y - u.y, C.position.z - u.z);
    const usc = u.scale * (u.ds ?? 1);
    const cut = 6.0 * dist / (U._pxk * usc);
    const v = new C.position.constructor(u.x, u.y, u.z).project(C);
    const sx = (v.x * .5 + .5) * W, sy = (.5 - v.y * .5) * H;
    if (sx < -50 || sx > W + 50 || sy < -50 || sy > H + 50) continue;
    const parts = u.def.parts;
    const drop = parts.filter(q => q._sz < cut).length;
    const sizes = parts.map(q => +(q._sz ?? 0).toFixed(3));
    out.push({ id: u.id, type: u.type, sx: sx | 0, sy: sy | 0, dist: +dist.toFixed(1), usc: +usc.toFixed(2),
      cut: +cut.toFixed(3), pxPerUnit: +(U._pxk / dist).toFixed(1), nparts: parts.length, drop,
      szMin: Math.min(...sizes), szMax: Math.max(...sizes), lean: +U._lean.toFixed(3) });
  }
  return { pxk: +U._pxk.toFixed(0), fov: C.fov, units: out };
}, null), null, 1));
console.log(JSON.stringify(errs.slice(0, 3)));
await b.close();
