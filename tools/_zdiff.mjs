// abs-diff two pngs -> out.png (amplified) + 16x9 map of mean abs diff
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , a, bF, out = 'shots/diff.png', amp = '6'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage({ viewport: { width: 1600, height: 900 } });
const res = await p.evaluate(async ({ ua, ub, amp }) => {
  const load = async u => { const i = new Image(); i.src = u; await i.decode(); return i; };
  const A = await load(ua), B = await load(ub);
  const c = document.createElement('canvas'); c.width = A.width; c.height = A.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(A, 0, 0); const da = g.getImageData(0, 0, c.width, c.height);
  g.drawImage(B, 0, 0); const db = g.getImageData(0, 0, c.width, c.height);
  const GX = 16, GY = 9, m = Array.from({ length: GY }, () => new Array(GX).fill(0)), n = Array.from({ length: GY }, () => new Array(GX).fill(0));
  for (let i = 0; i < da.data.length; i += 4) {
    const d = (Math.abs(da.data[i] - db.data[i]) + Math.abs(da.data[i + 1] - db.data[i + 1]) + Math.abs(da.data[i + 2] - db.data[i + 2])) / 3;
    const px = (i / 4) % c.width, py = ((i / 4) / c.width) | 0;
    m[(py * GY / c.height) | 0][(px * GX / c.width) | 0] += d; n[(py * GY / c.height) | 0][(px * GX / c.width) | 0]++;
    const v = Math.min(255, d * amp);
    da.data[i] = da.data[i + 1] = da.data[i + 2] = v;
  }
  g.putImageData(da, 0, 0);
  return { url: c.toDataURL(), m: m.map((r, y) => r.map((v, x) => +(v / n[y][x]).toFixed(2))) };
}, { ua: 'data:image/png;base64,' + readFileSync(a).toString('base64'), ub: 'data:image/png;base64,' + readFileSync(bF).toString('base64'), amp: +amp });
const { writeFileSync } = await import('node:fs');
writeFileSync(out, Buffer.from(res.url.split(',')[1], 'base64'));
console.log(res.m.map(r => r.map(v => String(v).padStart(7)).join('')).join('\n'));
await br.close();
