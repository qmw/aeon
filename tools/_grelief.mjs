// how much of the board does grid.js's relief window actually cull, and where?
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 2, null, { timeout: 300000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const map = window.map, ter = window.terrain, C = [];
  for (let k = 0; k < 6; k++) C.push([Math.cos(k * Math.PI / 3), Math.sin(k * Math.PI / 3)]);
  const A2W = (q, r) => ({ x: 1.5 * q, z: Math.sqrt(3) * (r + q / 2) });
  const by = {}, all = [];
  for (const t of map.tiles) {
    if (t.height <= 0) continue;
    const c = A2W(t.q, t.r); let lo = 1e9, hi = -1e9;
    for (const k of C) { const y = Math.max(0.15, ter.heightAt(c.x + k[0], c.z + k[1])); lo = Math.min(lo, y); hi = Math.max(hi, y); }
    const rel = hi - lo; all.push(rel);
    (by[t.biome] = by[t.biome] || []).push(rel);
  }
  const q = (a, t) => { a = a.slice().sort((x, y) => x - y); return +a[Math.floor(a.length * t)].toFixed(2); };
  const out = { land: all.length, relief_p50: q(all, .5), relief_p90: q(all, .9), relief_max: +Math.max(...all).toFixed(2) };
  for (const [k, a] of Object.entries(by)) out[k] = { n: a.length, p50: q(a, .5), p90: q(a, .9) };
  return out;
}), null, 1));
await b.close();
