// per-pixel band balance |mid|/|hf| exactly as post.js's present pass computes it, measured
// offline on a PNG so the gate window can be picked instead of guessed.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const file = process.argv[2];
const regions = process.argv.slice(3).map(s => { const [r, name] = s.split(':'); const [x, y, w, h] = r.split(',').map(Number); return { x, y, w, h, name }; });
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage();
console.log(JSON.stringify(await p.evaluate(async ({ url, regions }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width;
  const L = (x, y) => { const o = (y * W + x) * 4; return (0.2126 * d[o] + 0.7152 * d[o + 1] + 0.0722 * d[o + 2]) / 255; };
  const out = {};
  for (const R of regions) {
    const a = [];
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
      const rng4 = (L(x, y - 1) + L(x - 1, y) + L(x + 1, y) + L(x, y + 1)) * 0.25;
      const bg8 = (L(x + 8, y) + L(x - 8, y) + L(x, y + 8) + L(x, y - 8)
                 + L(x + 6, y + 6) + L(x - 6, y + 6) + L(x + 6, y - 6) + L(x - 6, y - 6)) * 0.125;
      a.push(Math.abs(rng4 - bg8) / Math.max(Math.abs(L(x, y) - rng4), 0.0035));
    }
    a.sort((u, v) => u - v);
    const q = t => +a[Math.floor(a.length * t)].toFixed(2);
    out[R.name] = { p10: q(.1), p25: q(.25), p50: q(.5), p75: q(.75), p90: q(.9) };
  }
  return out;
}, { url: 'data:image/png;base64,' + readFileSync(file).toString('base64'), regions }), null, 1));
await b.close();
