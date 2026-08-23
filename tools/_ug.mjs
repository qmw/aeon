// units agent scratch: report the grounding pass + city layout counts.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 4, null, { timeout: 240000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units;
  const builds = {}; let tot = 0;
  for (const [k, v] of U.builds) { builds[k] = v.length; tot += v.length; }
  const dim = {}; for (const [k, v] of U.bdim) dim[k] = [ +v.rx.toFixed(2), +v.rz.toFixed(2), +v.h.toFixed(2) ];
  return {
    shadowsN: U.shadows.n, shadowCap: U.shadows.cap, decalsN: U.decals.n,
    props: tot, builds,
    dimKeep: dim['keep'], dimHouse: dim['house:0'] || dim['house:3'], dimPole: dim['pole'],
    cities: U.cities.map(c => { const b={}; for (const [k,v] of U.builds) { const m=v.filter(x=>x.c===c).length; if(m) b[k]=m; } return { n: c.name, tier: c.tier, pop: c.pop, KH: c.KH, poles: c.poles.map(q=>+q.h.toFixed(2)), b }; }),
    units: [...U.units.values()].map(u => ({ t: u.type, s: +(u.scale*(u.ds??1)).toFixed(2), h: u.def.h })).slice(0, 6),
    sun: [U.sunDir.x.toFixed(2), U.sunDir.y.toFixed(2), U.sunDir.z.toFixed(2)],
    onScreen: (() => {
      const C = window.camera, W = 1600, H = 900, out = [];
      const V = new window.THREE.Vector3();
      for (const u of U.units.values()) {
        V.set(u.x, u.y, u.z).project(C);
        if (V.z > 1 || Math.abs(V.x) > 1 || Math.abs(V.y) > 1) continue;
        const x = Math.round((V.x*0.5+0.5)*W), y = Math.round((0.5-V.y*0.5)*H);
        const T = new window.THREE.Vector3(u.x, u.y + (u.def.h||0.85)*u.scale*(u.ds??1), u.z).project(C);
        out.push({ t: u.type, x, y, px: Math.round(((0.5-T.y*0.5)*H - y) * -1) });
      }
      return out;
    })(),
  };
}), null, 1));
await b.close();
