// units agent: park the real gameplay camera on one field unit and shoot it, at a fixed
// distance and pitch, so the loop is independent of whatever the camera agent is doing and
// survives the Vite HMR reloads the other three agents trigger every few minutes.
// usage: node tools/_uview.mjs out.png [dist] [pitchDeg] [w] [h]
import { chromium } from 'playwright';
const [, , out = 'shots/_uview.png', dist = '9', pitch = '52', w = '1000', h = '640'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
const install = ([D, PT, KIND]) => {
  const U = window.units, I = window.input, C = window.camera;
  if (!U || !C || !U.units.size) return null;
  if (I) I.update = () => {};
  const us = [...U.units.values()].filter(u => !u.water && !U._platAt.has(u.q * 4096 + u.r));
  const u = us.find(x => x.type === KIND) || us[0];
  if (!u) return null;
  U.puffs.mesh.visible = false;
  if (window.__ISO) {
    window.terrain.group.visible = false;
    if (window.water) window.water.group.visible = false;
    if (window.fx) window.fx.group.visible = false;
    for (const [, e] of U.bmesh) e.mesh.visible = false;
    U.decals.mesh.visible = U.shadows.mesh.visible = false;
    if (U.roadMesh) U.roadMesh.visible = false;
    for (const c of U.cities) if (c.plate) c.plate.visible = false;
    for (const o of window.scene.children) if (!o.isLight) o.visible = (o === U.group);
    window.scene.background = new (window.terrain.group.constructor.prototype.constructor === Object ? Object : Object)();
    window.renderer.setClearColor(0x23262b, 1);
    window.scene.background = null;
  }
  const e = PT * Math.PI / 180, a = 2.35;
  window.__lock = () => {
    C.position.set(u.x + Math.sin(a) * Math.cos(e) * D, u.y + Math.sin(e) * D, u.z + Math.cos(a) * Math.cos(e) * D);
    C.lookAt(u.x, u.y + 0.45, u.z); C.updateMatrixWorld();
    for (const el of document.querySelectorAll('.hud, #hud, .panel, .topbar, .rail')) el.style.display = 'none';
  };
  window.__lock(); window.__lockT = setInterval(window.__lock, 30);
  return { t: u.type, q: u.q, r: u.r, biome: U.map.get(u.q, u.r)?.biome, n: us.length };
};
await p.addInitScript(v => { window.__ISO = v; }, !!process.env.ISO);
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
let info = null;
for (let i = 0; i < 200 && !info; i++) {
  info = await p.evaluate(install, [+dist, +pitch, process.env.KIND || 'warrior']).catch(() => null);
  if (!info) await p.waitForTimeout(1000);
}
// keep it installed across HMR reloads, then hold the frame steady for the capture
const want = +(process.env.PF || 20);
for (let i = 0; i < 60; i++) {
  const st = await p.evaluate(() => ({ lock: !!window.__lock, f: window.__frameCount || 0 })).catch(() => ({ lock: false, f: 0 }));
  if (!st.lock) { await p.evaluate(install, [+dist, +pitch, process.env.KIND || 'warrior']).catch(() => {}); await p.evaluate(() => { window.__frameCount = 0; }).catch(() => {}); continue; }
  if (st.f >= want) break;
  await p.waitForTimeout(1500);
}
await p.waitForTimeout(400);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, info, errors: errors.slice(0, 4) }));
await b.close();
