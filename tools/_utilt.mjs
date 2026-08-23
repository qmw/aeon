// units agent: how far off vertical is each figure, and why. node tools/_utilt.mjs
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && window.units.units.size && (window.__frameCount || 0) >= 6, null, { timeout: 300000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units, C = window.camera;
  const f = { x: 0, y: 0, z: -1 };
  const q = C.quaternion, V = U.group.position.constructor;
  const fwd = new V(0, 0, -1).applyQuaternion(q);
  const out = { lean: U._lean, pxk: U._pxk, camFwdY: +fwd.y.toFixed(3), pitchDeg: +(Math.asin(-fwd.y) * 180 / Math.PI).toFixed(1), units: [] };
  for (const u of U.units.values()) {
    const m = u.bone[0];
    const up = new V(m.elements[4], m.elements[5], m.elements[6]).normalize();
    out.units.push({ id: u.id, type: u.type, q: u.q, r: u.r,
      tiltDeg: +(Math.acos(Math.min(1, up.y)) * 180 / Math.PI).toFixed(1),
      nx: +(u.nx ?? 0).toFixed(3), nz: +(u.nz ?? 0).toFixed(3), ds: +(u.ds ?? 1).toFixed(2),
      plat: U._platAt.has(u.q * 4096 + u.r), built: U._builtAt.has(u.q * 4096 + u.r) });
  }
  return out;
}, null)));
console.log(JSON.stringify(errs.slice(0, 3)));
await b.close();
