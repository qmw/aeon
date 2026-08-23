// scratch: Nyquist checker-energy + gradient stats over boxes. node tools/_nq.mjs in.png x y w h [x y w h ...]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , inp, ...rest] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage();
const out = await p.evaluate(async ({ b64, rest }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const W = img.width, H = img.height;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, W, H).data;
  const L = (x, y) => 0.299 * d[(y*W+x)*4] + 0.587 * d[(y*W+x)*4+1] + 0.114 * d[(y*W+x)*4+2];
  const res = [];
  for (let k = 0; k + 3 < rest.length; k += 4) {
    const [x0, y0, w, h] = rest.slice(k, k+4).map(Number);
    let ck = 0, gr = 0, n = 0, m = 0, m2 = 0;
    for (let y = y0; y < y0 + h - 1; y++) for (let x = x0; x < x0 + w - 1; x++) {
      const a = L(x,y), b = L(x+1,y), cc = L(x,y+1), dd = L(x+1,y+1);
      ck += Math.abs(a - b - cc + dd);
      gr += Math.abs(b - a) + Math.abs(cc - a);
      m += a; m2 += a*a; n++;
    }
    res.push({ box:[x0,y0,w,h], ratio:+(ck/Math.max(gr,1e-6)).toFixed(3), checker:+(ck/n).toFixed(2), grad:+(gr/n/2).toFixed(2), lum:+(m/n).toFixed(1), std:+Math.sqrt(m2/n-(m/n)**2).toFixed(1) });
  }
  return JSON.stringify(res);
}, { b64, rest });
console.log(out);
await br.close();
