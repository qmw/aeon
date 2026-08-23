// where are the crushed pixels? 12x8 grid of counts.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async url => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const GX = 12, GY = 8, grid = new Array(GX * GY).fill(0);
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y * c.width + x) * 4;
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    if (l < 4) grid[((y * GY / c.height) | 0) * GX + ((x * GX / c.width) | 0)]++;
  }
  return { size: [c.width, c.height], grid, GX, GY };
}, 'data:image/png;base64,' + readFileSync(process.argv[2]).toString('base64'));
for (let y = 0; y < out.GY; y++) console.log(out.grid.slice(y * out.GX, (y + 1) * out.GX).map(v => String(v).padStart(6)).join(''));
await b.close();
