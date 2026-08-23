// node .pcrop.mjs in.png out.png x y w h [scale]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,, inp, outp, X, Y, W, H, S = 2] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const data = await p.evaluate(async ([b64, x0, y0, w, h, s]) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const cv = document.createElement('canvas'); cv.width = w*s; cv.height = h*s;
  const c = cv.getContext('2d'); c.imageSmoothingEnabled = false;
  c.drawImage(img, x0, y0, w, h, 0, 0, w*s, h*s);
  return cv.toDataURL('image/png').split(',')[1];
}, [b64, +X, +Y, +W, +H, +S]);
writeFileSync(outp, Buffer.from(data, 'base64'));
await b.close();
console.log('ok', outp);
