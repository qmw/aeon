// units agent: dump every unit's screen-space bbox in the shipped framing. node tools/_upx.mjs [w] [h]
import { chromium } from 'playwright';
const [, , w = '1600', h = '900'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 4, null, { timeout: 240000 }).catch(() => {});
const info = await p.evaluate(() => {
  const U = window.units, C = window.camera, T = window.THREE || null;
  const W = window.innerWidth, H = window.innerHeight;
  const prj = (x, y, z) => { const v = new (U.group.position.constructor)(x, y, z); v.project(C); return [(v.x * .5 + .5) * W, (.5 - v.y * .5) * H]; };
  const out = [];
  for (const u of U.units.values()) {
    const hgt = (u.def.h || 0.85) * u.scale * (u.ds ?? 1);
    const [fx, fy] = prj(u.x, u.y, u.z);
    const [tx, ty] = prj(u.x, u.y + hgt, u.z);
    out.push({ id: u.id, type: u.type, q: u.q, r: u.r, sc: +u.scale.toFixed(2), h: +hgt.toFixed(2),
      px: [Math.round(fx), Math.round(fy)], hpx: Math.round(fy - ty), sel: !!u.sel });
  }
  // hex screen width: two adjacent tile centres
  const A = window.axialToWorld ? null : null;
  const c0 = U.cities[0];
  const hexpx = (() => {
    const s = U.map.get(8, 8); return null;
  })();
  return { n: U.units.size, cam: [+C.position.x.toFixed(1), +C.position.y.toFixed(1), +C.position.z.toFixed(1)], units: out,
    cities: U.cities.map(c => ({ name: c.name, pop: c.pop, tier: c.tier, q: c.q, r: c.r, px: prj(c.x, c.y, c.z).map(Math.round) })) };
});
console.log(JSON.stringify(info, null, 1));
console.log(JSON.stringify(errs.slice(0, 4)));
await b.close();
