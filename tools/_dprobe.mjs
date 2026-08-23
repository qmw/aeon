// units agent self-check: remove() must play a death flourish, then actually delete the unit.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 480, height: 270 } });
const errs = []; p.on('pageerror', e => errs.push(String(e))); p.on('console', m => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errs.push(m.text()); });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(6000);
console.log(JSON.stringify(await p.evaluate(() => {
  const u = window.units, id = [...u.units.keys()][0], n0 = u.units.size;
  u.remove(id);
  const mid = { dying: u.units.get(id)?.die !== undefined, size: u.units.size };
  // update() derives dt from the wall clock, so wind its clock back to fake 0.12 s a step
  for (let i = 0; i < 8; i++) { u._last -= 120; u.update(0.12); }   // 0.96 s, die += dt*1.5
  const after = { gone: !u.units.has(id), size: u.units.size, expect: n0 - 1 };
  // and a city removal must take its buildings, poles, roads and chimneys with it
  const c = u.cities[0], b0 = [...u.builds.values()].reduce((a, l) => a + l.length, 0);
  u.remove(c.id);
  return { mid, after, city: { gone: !u.cities.includes(c), builds0: b0, builds1: [...u.builds.values()].reduce((a, l) => a + l.length, 0) } };
}), null, 1));
console.log('ERR', errs.slice(0, 5));
await b.close();
