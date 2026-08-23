// units agent scratch: park the camera on one unit and shoot it. node tools/_uclose.mjs out.png [type] [dist]
import { chromium } from 'playwright';
const [, , out = 'shots/.uclose.png', type = 'warrior', dist = '4.5'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1300, height: 620 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 6, null, { timeout: 300000 }).catch(() => {});
const info = await p.evaluate(([type, dist]) => {
  const U = window.units, I = window.input, C = window.camera;
  if (I) I.update = () => {};
  U.setVisibility(null);
  // one of each on a clear line beside the first unit we can find
  const seed = [...U.units.values()][0];
  if (!seed) return 'no units';
  const kinds = ['warrior', 'spearman', 'archer', 'settler', 'builder'];
  const made = kinds.map((k, i) => U.add({ type: k, q: seed.q + 1 + i, r: seed.r + 3, team: 0, color: 0x4fa8ff }));
  U._slots();
  const us = made.map(id => U.units.get(id)).filter(Boolean);
  for (const u of us) { U._step(u, 0.5); U._step(u, 0.5); }
  const cx = us.reduce((s, u) => s + u.x, 0) / us.length;
  const cz = us.reduce((s, u) => s + u.z, 0) / us.length;
  const cy = us.reduce((s, u) => s + u.y, 0) / us.length;
  const d = +dist;
  C.position.set(cx + d * 0.62, cy + d * 0.72, cz + d * 0.62);
  C.lookAt(cx, cy + 0.45, cz);
  C.updateMatrixWorld(true);
  window.__lockCam = () => { C.position.set(cx + d * 0.62, cy + d * 0.72, cz + d * 0.62); C.lookAt(cx, cy + 0.45, cz);
    document.querySelectorAll('#hud,.hud,#ui,.aeon-hud').forEach(el => el.style.display = 'none'); };
  return { n: us.length, cx, cz };
}, [type, dist]);
await p.evaluate(() => new Promise(r => { const n = window.__frameCount; const t = setInterval(() => { window.__lockCam?.(); if (window.__frameCount > n + 26) { clearInterval(t); r(); } }, 60); }));
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, info, errs: errs.slice(0, 3) }));
await b.close();
