// units agent: one of every unit type on a line of land tiles. node tools/_uroster.mjs out.png [dist] [w] [h]
import { chromium } from 'playwright';
const [, , out = '/tmp/r.png', dist = '14', w = '1400', h = '520'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && window.units.units.size && (window.__frameCount || 0) >= 4, null, { timeout: 300000 }).catch(() => {});
await p.evaluate((v) => { window.__NOFLAG = v[0]; window.__ISO = v[1]; }, [!!process.env.NOFLAG, !!process.env.ISO]);
const installFn = ([dist]) => {
  const U = window.units, I = window.input, C = window.camera, M = U.map;
  if (I) I.update = () => {};
  for (const id of [...U.units.keys()]) U.remove(id);
  // a straight run of land tiles
  const kinds = ['warrior', 'spearman', 'archer', 'horseman', 'settler', 'builder', 'catapult'];
  let start = null;
  for (let r = 4; r < M.h - 4 && !start; r++) for (let q = 4; q < M.w - 12; q++) {
    let ok = true;
    for (let i = 0; i < 9 && ok; i++) for (const rr of [r, r + 2]) { const t = M.get(q + i, rr); if (!t || t.height <= 0 || !['grass','plains','beach','desert'].includes(t.biome)) { ok = false; break; } }
    if (ok) { start = { q, r }; break; }
  }
  if (!start) return 'no run';
  const ids = kinds.map((k, i) => U.add({ type: k, q: start.q + 1 + (i % 4) * 2, r: start.r + (i < 4 ? 0 : 2), team: 0, color: 0x4fa8ff }));
  const mine = ids.map(i => U.units.get(i)).filter(Boolean);
  const cx = mine.reduce((s, u) => s + u.x, 0) / mine.length;
  const cz = mine.reduce((s, u) => s + u.z, 0) / mine.length;
  const cy = mine.reduce((s, u) => s + u.y, 0) / mine.length;
  const D = +dist;
  const e = 38 * Math.PI / 180;
  window.__lock = () => { C.position.set(cx, cy + Math.sin(e) * D, cz + Math.cos(e) * D); C.lookAt(cx, cy + 0.4, cz); C.updateMatrixWorld(); };
  window.__lock(); setInterval(window.__lock, 30);
  document.querySelectorAll('#hud,.hud,#ui,.aeon-hud').forEach(el => el.style.display = 'none');
  if (window.__NOFLAG) U.flags.mesh.visible = false;
  if (window.__ISO) {
    for (const o of window.scene.children) if (!o.isLight) o.visible = (o === U.group);
    for (const [, e] of U.bmesh) e.mesh.visible = false;
    U.decals.mesh.visible = U.shadows.mesh.visible = U.puffs.mesh.visible = false;
    if (U.roadMesh) U.roadMesh.visible = false;
    for (const c of U.cities) if (c.plate) c.plate.visible = false;
    window.renderer.setClearColor(0x23262b, 1);
  }
  return { n: U.units.size, start, cx: +cx.toFixed(2), cz: +cz.toFixed(2) };
};
const info = await p.evaluate(installFn, [dist]);
// the other three agents save into this repo constantly and every save is an HMR reload that
// wipes the lock; reinstall until it sticks.
for (let i = 0; i < 40; i++) {
  const ok = await p.evaluate(() => !!window.__lock).catch(() => false);
  if (ok) break;
  await p.waitForFunction(() => window.units && window.units.units.size, null, { timeout: 300000 }).catch(() => {});
  await p.evaluate((v) => { window.__NOFLAG = v[0]; window.__ISO = v[1]; }, [!!process.env.NOFLAG, !!process.env.ISO]).catch(() => {});
  await p.evaluate(installFn, [dist]).catch(() => {});
}
const f0 = await p.evaluate(() => window.__frameCount || 0);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, f0 + (+process.env.PF || 22), { timeout: 300000 }).catch(() => {});
await p.waitForTimeout(600);
await p.screenshot({ path: out, timeout: 180000 });
console.log(JSON.stringify({ out, info, errors: errors.slice(0, 5) }));
await b.close();
