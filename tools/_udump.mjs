import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 500 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 4, null, { timeout: 240000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units;
  const us = [...U.units.values()].map(u => ({ t: u.type, team: u.spec?.team, col: (u.spec?.color||0).toString(16), q: u.q, r: u.r, x: +u.x.toFixed(1), z: +u.z.toFixed(1), ds: u.ds, water: !!u.water, flags: (u.def.flags||[]).length, fl: (u.team.flag||0).toString(16), fa: (u.team.a||0).toString(16) }));
  const cs = U.cities.map(c => ({ n: c.name, q: c.q, r: c.r, tier: c.tier, poles: c.poles.length, fl: (c.team.flag||0).toString(16) }));
  return { units: us, cities: cs };
}), null, 1));
await b.close();
