// simulate present.js's band operators on a PNG and re-measure HF/MID. Validates the model
// without a two-minute render. node tools/_gsim.mjs in.png cutMID cutHF x,y,w,h:name ...
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [file, cutMID, cutHF] = [process.argv[2], +process.argv[3], +process.argv[4]];
const regions = process.argv.slice(5).map(s => { const [r, n] = s.split(':'); const [x, y, w, h] = r.split(',').map(Number); return { x, y, w, h, name: n }; });
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
console.log(JSON.stringify(await p.evaluate(async ({ url, regions, cutMID, cutHF }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width, H = c.height;
  const lum = new Float32Array(W * H);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) lum[j] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const L = (x, y) => lum[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const rng4 = (L(x, y - 1) + L(x - 1, y) + L(x + 1, y) + L(x, y + 1)) * 0.25;
    const bg8 = (L(x + 8, y) + L(x - 8, y) + L(x, y + 8) + L(x, y - 8)
               + L(x + 6, y + 6) + L(x - 6, y + 6) + L(x + 6, y - 6) + L(x - 6, y - 6)) * 0.125;
    const v = L(x, y);
    out[y * W + x] = v + (rng4 - v) * cutHF - (rng4 - bg8) * cutMID;
  }
  const box = (r, x, y, A) => { let s = 0, n = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; s += A[yy * W + xx]; n++; } return s / n; };
  const meas = (A, R) => { let hf = 0, mid = 0, n = 0;
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
      const l = A[y * W + x];
      hf += Math.pow(l - box(1, x, y, A), 2); mid += Math.pow(box(2, x, y, A) - box(8, x, y, A), 2); n++; }
    const HF = Math.sqrt(hf / n), MID = Math.sqrt(mid / n);
    return { HF: +HF.toFixed(2), MID: +MID.toFixed(2), r: +(MID / HF).toFixed(2) }; };
  return regions.map(R => ({ name: R.name, before: meas(lum, R), after: meas(out, R) }));
}, { url: 'data:image/png;base64,' + readFileSync(file).toString('base64'), regions, cutMID, cutHF }), null, 1));
await b.close();
