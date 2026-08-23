// units agent: render the offscreen unit portraits and tile them into one png so they can be
// eyeballed. node tools/_uport.mjs out.png [px]
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const [, , out = 'shots/_uport.png', px = '192'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1200, height: 400 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && (window.__frameCount || 0) >= 6, null, { timeout: 300000 }).catch(() => {});
const res = await p.evaluate(([px]) => {
  const K = ['warrior', 'spearman', 'archer', 'horseman', 'settler', 'builder'];
  const civ = [0x4fa8ff, 0xd4483f, 0x4fa8ff, 0x37b48a, 0x4fa8ff, 0x4fa8ff];
  const urls = K.map((k, i) => { try { return window.units.portrait(k, civ[i], +px); } catch (e) { return 'ERR ' + e.message; } });
  const bad = urls.find(u => !u || u.startsWith('ERR'));
  if (bad) return { err: bad };
  const c = document.createElement('canvas'); c.width = +px * K.length; c.height = +px;
  const g = c.getContext('2d');
  return Promise.all(urls.map(u => new Promise(r => { const im = new Image(); im.onload = () => r(im); im.src = u; })))
    .then(ims => { ims.forEach((im, i) => g.drawImage(im, i * +px, 0)); return { png: c.toDataURL('image/png') }; });
}, [px]);
if (res.err) console.log(JSON.stringify(res));
else { writeFileSync(out, Buffer.from(res.png.split(',')[1], 'base64')); console.log(out); }
console.log(JSON.stringify(errs.slice(0, 3)));
await b.close();
