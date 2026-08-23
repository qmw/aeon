// grid legibility probe: for every visible hex edge, the luma DIP at the stroke against the
// local 19px box mean. Reports p50/p95 per depth band + the terrain's own noise floor.
// env: W,H,F  (viewport + frames to wait)
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const FILE = process.argv[2];   // measure THIS png (the live page only supplies the geometry)
const W = +(process.env.W || 1600), H = +(process.env.H || 900), F = +(process.env.F || 3);
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount || 0) >= n, F, { timeout: 300000 }).catch(() => {});
// sample points along every visible LAND hex edge, plus their screen-space edge normal
const pts = await p.evaluate(() => {
  const T = window.THREE, map = window.map, cam = window.camera, ter = window.terrain;
  const A2W = (q, r) => ({ x: 1.5 * q, z: Math.sqrt(3) * (r + q / 2) });
  const v = new T.Vector3(), v2 = new T.Vector3(), out = [];
  const proj = (x, z) => { const y = ter?.heightAt(x, z) ?? 0; v.set(x, y, z).project(cam);
    return { sx: (v.x * .5 + .5) * innerWidth, sy: (1 - (v.y * .5 + .5)) * innerHeight, z: v.z, y }; };
  for (const t of map.tiles) {
    if (t.height <= 0) continue;
    const c = A2W(t.q, t.r);
    for (let e = 0; e < 6; e++) {
      const a0 = e * Math.PI / 3, a1 = (e + 1) * Math.PI / 3;
      const x0 = c.x + Math.cos(a0), z0 = c.z + Math.sin(a0), x1 = c.x + Math.cos(a1), z1 = c.z + Math.sin(a1);
      for (const u of [0.3, 0.5, 0.7]) {
        const mx = x0 + (x1 - x0) * u, mz = z0 + (z1 - z0) * u;
        const A = proj(mx, mz); if (A.z > 1) continue;
        if (A.sx < 30 || A.sy < 70 || A.sx > innerWidth - 340 || A.sy > innerHeight - 60) continue;
        // screen-space direction of the edge -> perpendicular
        const B = proj(x0 + (x1 - x0) * (u + 0.06), z0 + (z1 - z0) * (u + 0.06));
        let dx = B.sx - A.sx, dy = B.sy - A.sy; const L = Math.hypot(dx, dy) || 1;
        out.push({ x: A.sx, y: A.sy, nx: -dy / L, ny: dx / L });
      }
    }
  }
  return out;
});
const { readFileSync } = await import('node:fs');
const png = 'data:image/png;base64,' + readFileSync(FILE).toString('base64');
console.log(JSON.stringify(await p.evaluate(async ({ png, pts }) => {
  const img = new Image(); img.src = png; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const L = (x, y) => { x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return null;
    const o = (y * c.width + x) * 4; return 0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]; };
  const box = (x, y, r) => { let s = 0, n = 0; for (let j = -r; j <= r; j += 2) for (let i = -r; i <= r; i += 2) { const l = L(x + i, y + j); if (l !== null) { s += l; n++; } } return n ? s / n : 0; };
  const bands = { far: [], mid: [], near: [] }, noise = { far: [], mid: [], near: [] };
  for (const P of pts) {
    const band = P.y < c.height * 0.34 ? 'far' : P.y < c.height * 0.62 ? 'mid' : 'near';
    let mn = 1e9; for (let k = -4.5; k <= 4.5; k += 0.5) { const l = L(P.x + P.nx * k, P.y + P.ny * k); if (l !== null) mn = Math.min(mn, l); }
    const bm = box(P.x, P.y, 9);
    if (mn < 1e8 && bm > 0) bands[band].push(bm - mn);
    // terrain noise floor: same statistic 5px OFF the edge (inside the tile)
    const ox = P.x + P.nx * 11, oy = P.y + P.ny * 11;
    let mn2 = 1e9; for (let k = -4.5; k <= 4.5; k += 0.5) { const l = L(ox + P.nx * k, oy + P.ny * k); if (l !== null) mn2 = Math.min(mn2, l); }
    const bm2 = box(ox, oy, 9);
    if (mn2 < 1e8 && bm2 > 0) noise[band].push(bm2 - mn2);
  }
  const q = (a, t) => { if (!a.length) return null; a = a.slice().sort((x, y) => x - y); return +a[Math.min(a.length - 1, Math.floor(a.length * t))].toFixed(1); };
  const rep = o => Object.fromEntries(Object.entries(o).map(([k, a]) => [k, { n: a.length, p25: q(a, .25), p50: q(a, .5), p75: q(a, .75), over25: +(100 * a.filter(v => v >= 25).length / Math.max(1, a.length)).toFixed(0) }]));
  return { edgeDip: rep(bands), noiseFloor: rep(noise) };
}, { png, pts }), null, 1));
await b.close();
