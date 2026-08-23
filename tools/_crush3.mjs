// crushed-pixel map at 32x18, plus a rough "is this the 3D playfield" split.
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
  const GX = 32, GY = 18, grid = new Array(GX*GY).fill(0);
  let tot = 0;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y*c.width+x)*4;
    const l = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
    if (l < 4) { grid[((y*GY/c.height)|0)*GX + ((x*GX/c.width)|0)]++; tot++; }
  }
  return { grid, GX, GY, tot, n: c.width*c.height };
}, 'data:image/png;base64,' + readFileSync(process.argv[2]).toString('base64'));
for (let y = 0; y < out.GY; y++) console.log(String(y*50).padStart(4)+' '+out.grid.slice(y*out.GX,(y+1)*out.GX).map(v=>v?String(v).padStart(4):'   .').join(''));
console.log('total', out.tot, (100*out.tot/out.n).toFixed(3)+'%');
await b.close();
