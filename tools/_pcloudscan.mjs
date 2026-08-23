// Scan drift phase + coverage against the REAL density field over the ground the camera sees.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 3, null, { timeout: 200000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, u = window.post.grade.uniforms, img = u.tCloud.value.image, D = img.data, S = img.width;
  const smp = (x, y) => { let fx = ((x % 1) + 1) % 1 * S - 0.5, fy = ((y % 1) + 1) % 1 * S - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const g = (a, c) => D[((((c % S) + S) % S) * S + (((a % S) + S) % S)) * 4] / 255;
    return (g(x0,y0)*(1-ax)+g(x0+1,y0)*ax)*(1-ay)+(g(x0,y0+1)*(1-ax)+g(x0+1,y0+1)*ax)*ay; };
  const sun = u.uSunW.value, K = u.uCloudK.value, CY = u.uCloudY.value;
  const cam = window.camera, ray = new T.Raycaster(), v = new T.Vector2();
  const GX = 24, GY = 14, pts = [];
  for (let sy = 0; sy < GY; sy++) for (let sx = 0; sx < GX; sx++) {
    v.set((sx + 0.5) / GX * 2 - 1, 1 - (sy + 0.5) / GY * 2);
    ray.setFromCamera(v, cam);
    const o = ray.ray.origin, dd = ray.ray.direction;
    let t = 20;
    for (let k = 0; k < 26; k++) { const py = o.y + dd.y*t, h = window.terrain?.heightAt(o.x+dd.x*t, o.z+dd.z*t) ?? 0;
      t += (py < h ? -(h-py) : (py-h)) * 0.55; if (!(t > 0 && t < 400)) break; }
    if (!(t > 0 && t < 300)) { pts.push(null); continue; }
    const wx = o.x + dd.x*t, wz = o.z + dd.z*t, wy = o.y + dd.y*t;
    const f = (CY - wy) / Math.max(sun.y, 0.25);
    pts.push([(wx + sun.x*f) * K, (wz + sun.z*f) * K, sx, sy]);
  }
  // the capital's own cell
  const cap = window.game.cities.find(c => c.capital && c.civ === 0);
  const cw = { x: 1.5 * cap.q, z: Math.sqrt(3) * (cap.r + cap.q/2) };
  const cy = window.terrain?.heightAt(cw.x, cw.z) ?? 2;
  const cf = (CY - cy) / Math.max(sun.y, 0.25);
  const capP = [(cw.x + sun.x*cf) * K, (cw.z + sun.z*cf) * K];
  const den = (a, bq, dx, dy) => smp(a+dx, bq+dy)*0.66 + smp((a+dx)*0.383+0.21, (bq+dy)*0.383+0.63)*0.34;
  const kf = (d, cov, w) => { const t = Math.min(1, Math.max(0, (d-cov)/w)); return t*t*(3-2*t); };
  let best = null;
  for (const cov of [0.58, 0.60, 0.62, 0.64]) for (let a = 0; a < 20; a++) for (let bq = 0; bq < 20; bq++) {
    const dx = a/20, dy = bq/20;
    let deep = 0, n = 0, low = 0, lm = 0, lmn = 0;
    for (const q of pts) { if (!q) continue; const k = kf(den(q[0],q[1],dx,dy), cov, 0.20); n++;
      if (k > 0.5) deep++;
      if (q[3] > GY*0.66 && k > 0.35) low++;                       // low: the near-reading band
      if (q[2] < GX*0.5 && q[3] > GY*0.10 && q[3] < GY*0.60) { lmn++; if (k > 0.5) lm++; } }
    const kc = kf(den(capP[0],capP[1],dx,dy), cov, 0.20);
    const frac = deep/n;
    const score = -Math.abs(frac - 0.26)*4 - kc*3 - (low/n)*2 + (lm/Math.max(lmn,1))*1.8;
    if (!best || score > best.score) best = { cov, dx: +dx.toFixed(3), dy: +dy.toFixed(3), frac: +frac.toFixed(3), kCap: +kc.toFixed(3), score: +score.toFixed(3) };
  }
  // render the winning mask
  const grid = [];
  for (const q of pts) grid.push(q ? +kf(den(q[0],q[1],best.dx,best.dy), best.cov, 0.20).toFixed(2) : -1);
  return { best, GX, GY, grid };
})));
await b.close();
