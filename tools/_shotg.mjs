// Screenshot + health check. Usage: node tools/shot.mjs <out.png> [w] [h] [waitMs] [url]
import { chromium } from 'playwright';
const [, , out = 'shots/shot.png', w = 1600, h = 900, waitMs = 3500, url = 'http://localhost:5173/'] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
p.on('pageerror', e => errors.push(String(e)));
await p.goto(url, { waitUntil: 'load', timeout: 60000 });
// Wait for the renderer to actually accumulate frames: TAA needs history, and this box
// draws ~1 fps under swiftshader, so a wall-clock wait screenshots an unconverged frame.
const wantFrames = +(process.env.SHOT_FRAMES || 60);
await p.waitForFunction(n => (window.__frameCount || 0) >= n, wantFrames, { timeout: 180000 }).catch(() => {});
await p.waitForTimeout(Math.min(+waitMs, 1500));
await p.screenshot({ path: out, timeout: 300000 });
// blank-frame detector: a featureless frame compresses to almost nothing
// ponytail: file-size heuristic, swap for pixel stats if it ever misfires
import { statSync } from 'node:fs';
const bytes = statSync(out).size;
const fps = await p.evaluate(() => window.__fps ?? null).catch(() => null);
console.log(JSON.stringify({ out, bytes, blank: bytes < 20000, fps, errors: errors.slice(0, 12) }));
await b.close();
