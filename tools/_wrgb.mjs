// node tools/_wrgb.mjs in.png x y w h [x y w h ...]  -> mean RGB, chroma, luma stats per box
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [, , inp, ...rest] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage();
await p.setContent('<canvas id=c></canvas>');
console.log(JSON.stringify(await p.evaluate(async ([b64, rest]) => {
  const img = new Image(); await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
  const c = document.getElementById('c'), g = c.getContext('2d');
  c.width = img.width; c.height = img.height; g.drawImage(img, 0, 0);
  const out = [];
  for (let k = 0; k + 3 < rest.length; k += 4) {
    const [x, y, w, h] = rest.slice(k, k + 4).map(Number);
    const d = g.getImageData(x, y, w, h).data; let R = 0, G = 0, B = 0, ch = 0, n = w * h, L = [];
    for (let i = 0; i < n; i++) { const r = d[i*4], gg = d[i*4+1], bb = d[i*4+2];
      R += r; G += gg; B += bb; ch += Math.max(r,gg,bb) - Math.min(r,gg,bb);
      L.push(0.2126*r+0.7152*gg+0.0722*bb); }
    L.sort((a,b)=>a-b);
    out.push({ box:[x,y,w,h], rgb:[R/n|0,G/n|0,B/n|0], chroma:+(ch/n).toFixed(1),
      p50:+L[n>>1].toFixed(0), p99:+L[Math.floor(n*0.99)].toFixed(0), max:+L[n-1].toFixed(0),
      over230:+(100*L.filter(v=>v>230).length/n).toFixed(2) });
  }
  return out;
}, [b64, rest]), null, 0));
await b.close();
