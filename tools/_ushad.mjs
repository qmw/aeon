// units agent scratch: is the prop grounding layer actually landing on the frame?
// Renders twice — shadows on / shadows off — and reports the mean luminance delta.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 900, height: 506 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 8, null, { timeout: 300000 }).catch(() => {});
const shot = async (on) => {
  await p.evaluate((v) => {
    const U = window.units; U.shadows.mesh.visible = v;
    U._lockShadow = true;
    // keep it pinned across frames
    if (!U.__patched) { U.__patched = 1; const f = U.flush; }
    Object.defineProperty(U.shadows.mesh, 'visible', { value: v, configurable: true, writable: true });
  }, on);
  await p.evaluate(() => new Promise(r => { const n = window.__frameCount; const t = setInterval(() => { if (window.__frameCount > n + 3) { clearInterval(t); r(); } }, 100); }));
  return await p.screenshot({ type: 'png' });
};
const A = await shot(true), B = await shot(false);
const out = await p.evaluate(async ([a, bb]) => {
  const load = (d) => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + d; });
  const ia = await load(a), ib = await load(bb);
  const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(ia, 0, 0); const da = g.getImageData(0, 0, c.width, c.height).data;
  g.clearRect(0,0,c.width,c.height); g.drawImage(ib, 0, 0); const db = g.getImageData(0, 0, c.width, c.height).data;
  let diff = 0, n = 0, mx = 0, mxi = 0;
  for (let i = 0; i < da.length; i += 4) {
    const la = 0.2126*da[i]+0.7152*da[i+1]+0.0722*da[i+2];
    const lb = 0.2126*db[i]+0.7152*db[i+1]+0.0722*db[i+2];
    const d = lb - la; if (d > 1) { diff += d; n++; }
    if (d > mx) { mx = d; mxi = i / 4; }
  }
  return { pixelsDarkened: n, meanDrop: +(diff / Math.max(1, n)).toFixed(2), maxDrop: mx,
           maxAt: [mxi % c.width, Math.floor(mxi / c.width)], size: [c.width, c.height] };
}, [A.toString('base64'), B.toString('base64')]);
import('node:fs').then(fs=>fs.writeFileSync('/home/piotr/looping_opus_5_test/shots/.ushad_on.png', A));
console.log(JSON.stringify(out));
await b.close();
