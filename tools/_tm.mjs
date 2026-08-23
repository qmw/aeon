// terrain agent scratch metric: region stats + high-pass sign-flip + depth bands
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
const file = resolve(process.argv[2]);
const regions = process.argv.slice(3).map(s => { const [r, name] = s.split(':'); const [x, y, w, h] = r.split(',').map(Number); return { x, y, w, h, name: name || `${x},${y}` }; });
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
const out = await p.evaluate(async ({ url, regions }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const W = c.width, H = c.height;
  const full = g.getImageData(0, 0, W, H).data;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; i < full.length; i += 4, j++) lum[j] = 0.2126 * full[i] + 0.7152 * full[i + 1] + 0.0722 * full[i + 2];
  const box = (r, x, y) => { let s = 0, n = 0; for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; s += lum[yy * W + xx]; n++; } return s / n; };
  const hp = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) hp[y * W + x] = lum[y * W + x] - box(1, x, y);
  const stat = R => {
    let hf = 0, mid = 0, n = 0, L = 0, S = 0, flip = 0, fn = 0;
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
      if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) continue;
      const i = y * W + x;
      hf += hp[i] * hp[i];
      mid += Math.pow(box(2, x, y) - box(8, x, y), 2);
      const o = i * 4, mx = Math.max(full[o], full[o + 1], full[o + 2]), mn = Math.min(full[o], full[o + 1], full[o + 2]);
      S += mx ? (mx - mn) / mx : 0; L += lum[i]; n++;
      if (hp[i] * hp[i + 1] < 0) flip++; fn++;
      if (hp[i] * hp[i + W] < 0) flip++; fn++;
    }
    const HF = Math.sqrt(hf / n), MID = Math.sqrt(mid / n);
    return { name: R.name, mean: +(L / n).toFixed(1), sat: +(S / n).toFixed(3), HF: +HF.toFixed(2), MID: +MID.toFixed(2), MH: +(MID / (HF || 1e-6)).toFixed(2), flip: +(flip / fn).toFixed(3) };
  };
  const defs = regions.length ? regions : [];
  const stats = defs.map(stat);
  // depth bands: 6 horizontal strips of the lower 2/3
  const bands = [];
  const bx = Math.round(W * 0.19), bw = Math.round(W * 0.62), bh = Math.round(H * 0.125);
  for (let k = 0; k < 6; k++) bands.push(stat({ x: bx, y: Math.round(H * 0.20) + k * bh, w: bw, h: bh - 2, name: 'band' + k }));
  let crushed = 0, blown = 0;
  const cells = [];
  for (let k = 0; k < 96; k++) cells.push(0);
  for (let i = 0; i < lum.length; i++) {
    if (lum[i] < 4) { crushed++; const x = i % W, y = (i / W) | 0; cells[((y * 8 / H) | 0) * 12 + ((x * 12 / W) | 0)]++; }
    if (lum[i] > 250) blown++;
  }
  return { cells, crushedPct: +(100 * crushed / lum.length).toFixed(2), blownPct: +(100 * blown / lum.length).toFixed(2), regions: stats, bands };
}, { url: 'data:image/png;base64,' + readFileSync(file).toString('base64'), regions });
const f = r => `${r.name.padEnd(12)} mean ${String(r.mean).padStart(6)}  sat ${r.sat.toFixed(3)}  HF ${String(r.HF).padStart(6)}  MID ${String(r.MID).padStart(6)}  M/H ${r.MH.toFixed(2)}  flip ${r.flip.toFixed(3)}`;
console.log('crushed', out.crushedPct + '%  blown', out.blownPct + '%');
if (out.crushedPct > 0.05) { console.log('crushed map (12x8 grid, counts/100):'); for (let r = 0; r < 8; r++) console.log(out.cells.slice(r*12,r*12+12).map(v=>String(Math.round(v/100)).padStart(5)).join('')); }
out.regions.forEach(r => console.log(f(r)));
console.log('-- depth bands (top->bottom) --');
out.bands.forEach(r => console.log(f(r)));
await b.close();
