// eye depth of the four gate regions, by raycasting the real scene.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount||0) >= n, +(process.env.F||4), { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, cam = window.camera;
  const pts = { 'far-cliff':[180,170], mid:[500,460], 'near-field':[820,780], water:[1270,280], 'top-edge':[800,70], 'bottom-edge':[800,560] };
  const rc = new T.Raycaster(); const out = { camY:+cam.position.y.toFixed(1), fov:cam.fov, pitchDeg:null };
  const fwd = new T.Vector3(0,0,-1).applyQuaternion(cam.quaternion);
  out.pitchDeg = +(-Math.asin(fwd.y)*180/Math.PI).toFixed(1);
  const targets = [window.terrain?.group, window.water?.group].filter(Boolean);
  for (const k in pts) {
    const [x,y] = pts[k];
    rc.setFromCamera(new T.Vector2(x/1600*2-1, -(y/900*2-1)), cam);
    const hs = rc.intersectObjects(targets, true);
    const h = hs.find(o=>o.distance>0.5);
    // eye depth = -z in view space
    let ed = null;
    if (h) { const v = h.point.clone().applyMatrix4(cam.matrixWorldInverse); ed = +(-v.z).toFixed(1); }
    out[k] = { hit: !!h, eyeDepth: ed, dist: h ? +h.distance.toFixed(1) : null };
  }
  return out;
}), null, 1));
await b.close();
