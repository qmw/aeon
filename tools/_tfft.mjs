// terrain scratch: 2D autocorrelation peaks of the high-passed luminance in a region.
// node tools/_tfft.mjs shot.png x y w h
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , f, X, Y, W, H] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async ({ url, X, Y, W, H }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(X, Y, W, H).data;
  const L = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) L[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  // high-pass: subtract a 9x9 box
  const hp = new Float32Array(W * H);
  const box = (x, y, r) => { let s = 0, n = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; s += L[yy * W + xx]; n++; } return s / n; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) hp[y * W + x] = L[y * W + x] - box(x, y, 4);
  const M = 20, res = [];
  let z = 0; for (let i = 0; i < hp.length; i++) z += hp[i] * hp[i]; z /= hp.length;
  for (let dy = -M; dy <= M; dy++) for (let dx = 0; dx <= M; dx++) {
    if (dx === 0 && dy <= 0) continue;
    let s = 0, n = 0;
    for (let y = Math.max(0, -dy); y < Math.min(H, H - dy); y++) for (let x = 0; x < W - dx; x++) { s += hp[y * W + x] * hp[(y + dy) * W + x + dx]; n++; }
    res.push({ dx, dy, r: +(s / n / z).toFixed(3) });
  }
  res.sort((a, b) => b.r - a.r);
  return { rms: +Math.sqrt(z).toFixed(2), top: res.slice(0, 12) };
}, { url: 'data:image/png;base64,' + readFileSync(f).toString('base64'), X: +X, Y: +Y, W: +W, H: +H });
console.log(JSON.stringify(out));
await b.close();
