// scratch(post): tools/shot.mjs with a longer TAA-convergence timeout. The scene has grown
// past ~6 s/frame at 1600x900 on this box, so 60 frames needs ~7 minutes and shot.mjs's
// hardcoded 180 s wait fires first and captures the pre-boot black page.
// Usage: SHOT_FRAMES=60 node tools/_pshot.mjs out.png [w] [h] [url]
import { chromium } from 'playwright';
import { statSync } from 'node:fs';
const [, , out = 'shots/shot.png', w = 1600, h = 900, url = 'http://localhost:5173/'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 120000 });
const want = +(process.env.SHOT_FRAMES || 60);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, want, { timeout: +(process.env.SHOT_TIMEOUT || 1200000) }).catch(() => {});
await p.waitForTimeout(1500);
await p.screenshot({ path: out });
const bytes = statSync(out).size;
console.log(JSON.stringify({ out, bytes, blank: bytes < 20000,
  frames: await p.evaluate(() => window.__frameCount), mspf: await p.evaluate(() => window.__mspf ?? null),
  errors: errors.slice(0, 12) }));
await b.close();
