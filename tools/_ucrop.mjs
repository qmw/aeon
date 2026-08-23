// crop+zoom a shot. node tools/_ucrop.mjs in.png out.png x y w h [zoom]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, inp, out, x, y, w, h, z = 4] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
const d = await p.evaluate(async ({ url, x, y, w, h, z }) => {
  const img = new Image(); img.src = url; await img.decode();
  const c = document.createElement('canvas'); c.width = w * z; c.height = h * z;
  const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
  g.drawImage(img, x, y, w, h, 0, 0, w * z, h * z);
  return c.toDataURL('image/png');
}, { url: 'data:image/png;base64,' + readFileSync(inp).toString('base64'), x: +x, y: +y, w: +w, h: +h, z: +z });
writeFileSync(out, Buffer.from(d.split(',')[1], 'base64'));
console.log(out);
await b.close();
