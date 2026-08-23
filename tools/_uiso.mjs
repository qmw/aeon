// units agent: shipped framing, ONLY units.group visible. node tools/_uiso.mjs out.png [w] [h] [frames]
import { chromium } from 'playwright';
const [, , out = '/tmp/uiso.png', w = '1600', h = '900', fr = '24'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && (window.__frameCount || 0) >= 3, null, { timeout: 300000 }).catch(() => {});
const iso = () => {
  const U = window.units;
  for (const o of window.scene.children) if (!o.isLight) o.visible = (o === U.group);
  document.querySelectorAll('#hud,.hud,#ui,.aeon-hud').forEach(el => el.style.display = 'none');
  window.renderer.setClearColor(0x1b1e22, 1);
  if (window.__UONLY) {
    for (const [, e] of U.bmesh) e.mesh.visible = false;
    if (U.roadMesh) U.roadMesh.visible = false;
    for (const c of U.cities) if (c.plate) c.plate.visible = false;
    U.flags.mesh.visible = false; U.decals.mesh.visible = false; U.shadows.mesh.visible = false;
  }
  return true;
};
await p.evaluate((v) => { window.__UONLY = v; }, !!process.env.UONLY);
await p.evaluate(iso);
await p.evaluate((f) => new Promise(r => { const n = window.__frameCount; const t = setInterval(() => { if (window.__frameCount > n + f) { clearInterval(t); r(); } }, 80); }), +fr);
await p.evaluate(iso);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, errs: errs.slice(0, 3) }));
await b.close();
