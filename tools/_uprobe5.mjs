// units probe with frame waiting. node /tmp/uprobe.mjs out.png what dist w h yaw pitch
import { chromium } from 'playwright';
const [, , out = '/tmp/p.png', what = 'warrior', dist = '9', w = '1200', h = '800', yaw = '25', pitch = '34'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 8, null, { timeout: 180000 }).catch(()=>{});
const info = await p.evaluate(([what, dist, yaw, pitch]) => {
  const U = window.units, I = window.input, C = window.camera;
  if (!U || !C) return 'no units';
  const list = [...U.units.values()];
  let t = null, ty = 0;
  if (what === 'boat') t = list.find(u => u.def.boat);
  else if (what.startsWith('city')) { t = U.cities[+what.slice(4) || 0]; ty = 0.6; }
  else t = list.find(u => u.type === what) || list[0];
  if (!t) return 'not found ' + [...new Set(list.map(u => u.type))].join(',');
  if (I) I.update = () => {};
  const a = +yaw * Math.PI / 180, e = +pitch * Math.PI / 180, D = +dist;
  window.__lock = () => { C.position.set(t.x + Math.sin(a) * Math.cos(e) * D, (t.y || 0) + ty + Math.sin(e) * D, t.z + Math.cos(a) * Math.cos(e) * D); C.lookAt(t.x, (t.y || 0) + ty + D * 0.06, t.z); C.updateMatrixWorld(); };
  window.__lock();
  document.querySelectorAll('#hud,.hud,#ui,.aeon-hud').forEach(el => el.style.display = 'none');
  const id = setInterval(window.__lock, 30);
  return (t.type || t.name) + ' fc=' + window.__frameCount;
}, [what, dist, yaw, pitch]);
const f0 = await p.evaluate(() => window.__frameCount || 0);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, f0 + (+process.env.PF || 30), { timeout: 240000 }).catch(()=>{});
await p.waitForTimeout(800);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, info, fc: await p.evaluate(()=>window.__frameCount), errors: errors.slice(0, 6) }));
await b.close();
