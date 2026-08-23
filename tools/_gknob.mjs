// A/B a post.js uniform change inside ONE page session: render, measure, poke the uniform,
// re-converge, measure again. Two minutes instead of two screenshots and ten.
// node tools/_gknob.mjs "uCutMID=1.2,uAddMID=0" x,y,w,h:name ...     env: W,H,F
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const W = +(process.env.W || 1600), H = +(process.env.H || 900), F = +(process.env.F || 20);
const set = process.argv[2].split(',').filter(Boolean).map(kv => kv.split('='));
const regions = process.argv.slice(3).map(s => { const [r, n] = s.split(':'); const [x, y, w, h] = r.split(',').map(Number); return { x, y, w, h, name: n }; });
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0, 300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
const wait = () => p.waitForFunction(n => (window.__frameCount || 0) >= n, F, { timeout: 600000 }).catch(() => {});
await wait();
const A = (await p.screenshot({ timeout: 240000 })).toString('base64');
console.log(JSON.stringify(await p.evaluate(kvs => {
  const u = { ...window.post._mPresent.uniforms, ...window.post.grade.uniforms };
  const seen = {};
  for (const [k, v] of kvs) { const t = window.post._mPresent.uniforms[k] || window.post.grade.uniforms[k];
    seen[k] = t ? [t.value, +v] : 'MISSING'; if (t) t.value = +v; }
  window.post._frame = 0; window.__frameCount = 0; return seen;
}, set)));
await wait();
const Bimg = (await p.screenshot({ timeout: 240000 })).toString('base64');
console.log(JSON.stringify(await p.evaluate(async ({ a, bb, regions }) => {
  const load = async s => { const i = new Image(); i.src = 'data:image/png;base64,' + s; await i.decode();
    const cv = document.createElement('canvas'); cv.width = i.width; cv.height = i.height;
    const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0);
    const d = g.getImageData(0, 0, i.width, i.height).data, L = new Float32Array(i.width * i.height);
    for (let k = 0, j = 0; k < d.length; k += 4, j++) L[j] = 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
    return { L, w: i.width, h: i.height, d }; };
  const meas = (I, R) => {
    const box = (r, x, y) => { let s = 0, n = 0; for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) { const xx = x + i, yy = y + j; if (xx < 0 || yy < 0 || xx >= I.w || yy >= I.h) continue; s += I.L[yy * I.w + xx]; n++; } return s / n; };
    let hf = 0, mid = 0, n = 0, m = 0, sat = 0;
    for (let y = R.y; y < R.y + R.h; y++) for (let x = R.x; x < R.x + R.w; x++) {
      const l = I.L[y * I.w + x]; hf += Math.pow(l - box(1, x, y), 2); mid += Math.pow(box(2, x, y) - box(8, x, y), 2);
      const o = (y * I.w + x) * 4, mx = Math.max(I.d[o], I.d[o+1], I.d[o+2]), mn = Math.min(I.d[o], I.d[o+1], I.d[o+2]);
      sat += mx ? (mx - mn) / mx : 0; m += l; n++; }
    const HF = Math.sqrt(hf / n), MID = Math.sqrt(mid / n);
    return { mean: +(m / n).toFixed(1), sat: +(sat / n).toFixed(3), HF: +HF.toFixed(2), MID: +MID.toFixed(2), r: +(MID / HF).toFixed(2) }; };
  const IA = await load(a), IB = await load(bb);
  return regions.map(R => ({ name: R.name, before: meas(IA, R), after: meas(IB, R) }));
}, { a: A, bb: Bimg, regions }), null, 1));
await b.close();
