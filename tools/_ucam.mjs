import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) > 8, null, { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const C = window.camera, U = window.units;
  const d = new C.position.constructor(0,0,-1).applyQuaternion(C.quaternion);
  const u = [...U.units.values()].find(x=>!x.water) || {x:0,y:0,z:0};
  const dist = Math.hypot(C.position.x-u.x, C.position.y-u.y, C.position.z-u.z);
  return { pitchDeg: +(-Math.asin(d.y)*180/Math.PI).toFixed(1), fov: C.fov,
           camY: +C.position.y.toFixed(1), distToUnit: +dist.toFixed(1), zoom: window.input?.zoom };
}), null, 1));
await b.close();
