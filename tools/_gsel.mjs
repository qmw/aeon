// grid scratch: where is the selected unit / range on screen?
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,200)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 3, null, { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, cam = window.camera, g = window.input?.grid, hx = window.hex || null;
  const proj = (x,y,z) => { const v = new T.Vector3(x,y,z).project(cam); return [Math.round((v.x*0.5+0.5)*1600), Math.round((-v.y*0.5+0.5)*900)]; };
  const out = { sel: null, range: g?._range?.length ?? null, work: g?._work?.length ?? null, path: g?._path?.length ?? null };
  const t = g?._sel;
  if (t) { const w = window.__axial ? null : null; }
  // use terrain heightAt + the same axial transform grid.js uses
  const A = (q,r) => ({ x: 1.5*q, z: Math.sqrt(3)*(r + q/2) });
  if (t) { const w = A(t.q,t.r); out.sel = { q:t.q, r:t.r, px: proj(w.x, window.terrain.heightAt(w.x,w.z)+0.2, w.z) }; }
  if (g?._range?.length) out.rangePx = g._range.slice(0,6).map(u=>{ const w=A(u.q,u.r); return proj(w.x, window.terrain.heightAt(w.x,w.z), w.z); });
  return out;
}), null, 1));
await b.close();
