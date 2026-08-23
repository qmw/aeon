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
  const rows = [];
  // HUD rects (x,y,w,h) to exclude
  const HUD = [[0,0,1600,58],[1260,60,340,248],[1280,580,320,300],[8,664,404,220]];
  let inHud = 0, outHud = 0;
  for (let y = 0; y < c.height; y++) {
    let n = 0;
    for (let x = 0; x < c.width; x++) {
      const i = (y*c.width+x)*4, l = 0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
      if (l < 4) { n++; if (HUD.some(([hx,hy,hw,hh]) => x>=hx&&x<hx+hw&&y>=hy&&y<hy+hh)) inHud++; else outHud++; }
    }
    if (n > 40) rows.push([y, n]);
  }
  return { rows: rows.slice(0, 40), inHud, outHud, total: c.width*c.height };
}, 'data:image/png;base64,' + readFileSync(f).toString('base64'));
console.log(JSON.stringify(out));
await b.close();
