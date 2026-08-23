// same contract as tools/shot.mjs, but tolerant of a loaded box
import { chromium } from 'playwright';
const [, , out = 'shots/shot.png', w = 1600, h = 900] = process.argv;
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.setDefaultTimeout(180000);
const errors = [];
p.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 300)); });
p.on('pageerror', e => errors.push(String(e).slice(0, 300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(n => (window.__frameCount || 0) >= n, +(process.env.SHOT_FRAMES || 60), { timeout: 600000 }).catch(() => {});
await p.waitForTimeout(1500);
await p.screenshot({ path: out, timeout: 180000 });
const { statSync } = await import('node:fs');
const bytes = statSync(out).size;
console.log(JSON.stringify({ out, bytes, blank: bytes < 20000, fps: await p.evaluate(() => window.__fps ?? null), errors: errors.slice(0, 8) }));
await b.close();
