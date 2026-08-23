import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(5000);
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units; if (!U) return null;
  return {
    fps: window.__fps,
    cities: U.cities.map(c => ({ n: c.name, q: c.q, r: c.r, x: +c.x.toFixed(1), z: +c.z.toFixed(1), y: +c.y.toFixed(2), tier: c.tier })),
    units: [...U.units.values()].map(u => ({ t: u.type, x: +u.x.toFixed(1), z: +u.z.toFixed(1), y: +u.y.toFixed(2) })),
    inputKeys: window.input ? Object.keys(window.input) : null,
    draws: window.renderer.info.render.calls, tris: window.renderer.info.render.triangles,
  };
}), null, 1));
await b.close();
