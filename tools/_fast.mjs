// fast scouting shot: node tools/_fast.mjs out.png [frames] [jsExpr] [url]
import { chromium } from 'playwright';
const [,,out='shots/_fast.png', frames='10', js='', url='http://localhost:5173/'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
p.on('console', m => { if (m.type()==='error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__ready, null, { timeout: 120000 }).catch(()=>{});
if (js) await p.evaluate(js);
const n0 = await p.evaluate(() => window.__frameCount||0);
await p.waitForFunction(n => (window.__frameCount||0) >= n, n0 + (+frames), { timeout: 180000 }).catch(()=>{});
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, fps: await p.evaluate(()=>window.__fps), errors: errors.slice(0,8) }));
await b.close();
