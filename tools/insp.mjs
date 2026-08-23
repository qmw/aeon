// crop+zoom a png and report luminance/edge stats. usage: node tools/insp.mjs in.png out.png x y w h [scale]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const [, , inp, out, X = 0, Y = 0, W = 400, H = 300, S = 3] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await br.newPage({ viewport: { width: Math.round(W * S), height: Math.round(H * S) } });
const stats = await p.evaluate(async ({ b64, X, Y, W, H, S }) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d'); g.drawImage(img, -X, -Y);
  const d = g.getImageData(0, 0, W, H).data;
  const lum = new Float64Array(W * H);
  for (let i = 0; i < W * H; i++) lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let e = 0, n = 0, m = 0, m2 = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    e += Math.abs(lum[i] - lum[i + 1]) + Math.abs(lum[i] - lum[i + W]); n++;
  }
  for (let i = 0; i < W * H; i++) { m += lum[i]; m2 += lum[i] * lum[i]; }
  m /= W * H;
  // scaled view
  const c2 = document.createElement('canvas'); c2.width = W * S; c2.height = H * S;
  const g2 = c2.getContext('2d'); g2.imageSmoothingEnabled = false;
  g2.drawImage(c, 0, 0, W * S, H * S);
  document.body.style.margin = '0';
  document.body.appendChild(c2);
  return { edge_mean: +(e / n).toFixed(2), lum_mean: +m.toFixed(1), lum_std: +Math.sqrt(m2 / (W * H) - m * m).toFixed(1) };
}, { b64, X: +X, Y: +Y, W: +W, H: +H, S: +S });
await p.screenshot({ path: out });
console.log(JSON.stringify(stats));
await br.close();
