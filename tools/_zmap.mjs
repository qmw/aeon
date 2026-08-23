// where are the crushed/blown pixels? 16x9 grid of counts. node tools/_zmap.mjs img.png
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const f = process.argv[2];
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const out = await p.evaluate(async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const GX = 16, GY = 9, cr = Array.from({length:GY},()=>new Array(GX).fill(0)), bl = Array.from({length:GY},()=>new Array(GX).fill(0));
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const i = (y*c.width+x)*4, l = 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
    if (l < 4) cr[(y*GY/c.height)|0][(x*GX/c.width)|0]++;
    if (l > 250) bl[(y*GY/c.height)|0][(x*GX/c.width)|0]++;
  }
  return { cr, bl };
}, 'data:image/png;base64,' + readFileSync(f).toString('base64'));
const fmt = m => m.map(r => r.map(v => String(v).padStart(6)).join('')).join('\n');
console.log('CRUSHED\n' + fmt(out.cr) + '\nBLOWN\n' + fmt(out.bl));
await b.close();
