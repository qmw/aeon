// units agent: luma stats over a rect. node tools/_ustats.mjs in.png x y w h
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [, , inp, x, y, w, h] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage();
await p.setContent('<canvas id=c></canvas>');
const r = await p.evaluate(async ([b64, x, y, w, h]) => {
  const img = new Image(); await new Promise(r => { img.onload = r; img.src = 'data:image/png;base64,' + b64; });
  const c = document.getElementById('c'), g = c.getContext('2d', { willReadFrequently: true });
  c.width = img.width; c.height = img.height; g.drawImage(img, 0, 0);
  const d = g.getImageData(+x, +y, +w, +h).data;
  const L = []; for (let i = 0; i < d.length; i += 4) L.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
  L.sort((a, b) => a - b);
  const q = (t) => Math.round(L[Math.floor(t * (L.length - 1))]);
  return { n: L.length, min: q(0), p1: q(0.01), p50: q(0.5), p99: q(0.99), max: q(1),
    mean: Math.round(L.reduce((a, b) => a + b, 0) / L.length) };
}, [b64, x, y, w, h]);
console.log(inp, JSON.stringify(r));
await br.close();
