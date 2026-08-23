// probe: run JS before the shot. node probe.mjs out.png "js" [frames] [w] [h]
import { chromium } from 'playwright';
const [, , out = 'shots/p.png', js = '', frames = '25', w = '1600', h = '900'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('pageerror', e => errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.__ready, null, { timeout: 60000 }).catch(() => {});
if (js) await p.evaluate(js).catch(e => errors.push('js:' + e));
await p.evaluate(() => { window.__frameCount = 0; if (window.post) window.post._frame = 0; });
await p.waitForFunction(n => (window.__frameCount || 0) >= n, +frames, { timeout: 300000 }).catch(() => {});
await p.waitForTimeout(600);
await p.screenshot({ path: out });
console.log(JSON.stringify({ out, errors: errors.slice(0, 6) }));
await b.close();
