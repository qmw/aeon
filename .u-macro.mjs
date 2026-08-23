// units agent: macro lens. Parks the camera manually (input disabled) for silhouette checks.
//   node .u-macro.mjs <out.png> <x> <z> <dist> <pitchDeg> <yawDeg> [w] [h] [wait] [hideHud]
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const A = process.argv.slice(2);
const [out='shots/m.png', x=64.5, z=66.7, dist=6, pitch=22, yaw=20, w=1400, h=800, wait=4000, hideHud=1, expr=''] = A;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type()==='error' && !/favicon|Failed to load/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(+wait);
const st = await p.evaluate(([x,z,dist,pitch,yaw,hide,expr]) => {
  if (window.input) window.input.update = () => {};
  if (hide) { const u = document.getElementById('hud') || document.querySelector('.hud'); for (const el of document.body.children) if (el.tagName !== 'CANVAS') el.style.display='none'; }
  const c = window.camera, T = window.THREE;
  const gy = window.terrain?.heightAt ? window.terrain.heightAt(x, z) : 0;
  const tgt = new T.Vector3(x, gy + 0.35, z);
  const py = pitch*Math.PI/180, ya = yaw*Math.PI/180;
  c.position.set(tgt.x + Math.sin(ya)*Math.cos(py)*dist, tgt.y + Math.sin(py)*dist, tgt.z + Math.cos(ya)*Math.cos(py)*dist);
  c.lookAt(tgt); c.near = 0.1; c.updateProjectionMatrix();
  if (expr) { try { eval(expr); } catch (e) { return { evalErr: String(e) }; } }
  return { fps: window.__fps, draws: window.renderer.info.render.calls, tris: window.renderer.info.render.triangles };
}, [+x, +z, +dist, +pitch, +yaw, +hideHud, expr]);
await p.waitForTimeout(1200);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, bytes: statSync(out).size, ...st, errors: errors.slice(0,6) }));
await b.close();
