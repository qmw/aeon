// scratch(post): solve (coverage, drift) for the cloud-shadow mask against the REAL density
// field over the ground THIS camera sees. Prints the winning pair and an ASCII map of it.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,300)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 2, null, { timeout: 240000 }).catch(()=>{});
const r = await p.evaluate(() => {
  const T = window.THREE, u = window.post.grade.uniforms, img = u.tCloud.value.image, D = img.data, S = img.width;
  const smp = (x, y) => { let fx = ((x % 1) + 1) % 1 * S - 0.5, fy = ((y % 1) + 1) % 1 * S - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
    const g = (a, c) => D[((((c % S) + S) % S) * S + (((a % S) + S) % S)) * 4] / 255;
    return (g(x0,y0)*(1-ax)+g(x0+1,y0)*ax)*(1-ay)+(g(x0,y0+1)*(1-ax)+g(x0+1,y0+1)*ax)*ay; };
  const sun = u.uSunW.value, K = u.uCloudK.value, CY = u.uCloudY.value, W = u.uCloudW.value;
  const cam = window.camera, ray = new T.Raycaster(), v = new T.Vector2();
  const GX = 32, GY = 18, pts = [];
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
    pts.push([(wx + sun.x*f) * K, (wz + sun.z*f) * K, sx, sy, wy]);
  }
  const cap = window.game?.cities?.find(c => c.capital && c.civ === 0) ?? window.game?.cities?.[0];
  const cw = { x: 1.5 * cap.q, z: Math.sqrt(3) * (cap.r + cap.q/2) };
  const cy = window.terrain?.heightAt(cw.x, cw.z) ?? 2;
  const cf = (CY - cy) / Math.max(sun.y, 0.25);
  const capP = [(cw.x + sun.x*cf) * K, (cw.z + sun.z*cf) * K];
  const den = (a, bq, dx, dy) => smp(a+dx, bq+dy)*0.66 + smp((a+dx)*0.383+0.21, (bq+dy)*0.383+0.63)*0.34;
  const kf = (d, cov) => { const t = Math.min(1, Math.max(0, (d-(cov-W))/(2*W))); return t*t*(3-2*t); };
  // what does the field actually RANGE over the ground in frame?
  let lo = 9, hi = -9; for (const q of pts) if (q) { const dv = den(q[0],q[1],0,0); lo = Math.min(lo,dv); hi = Math.max(hi,dv); }
  let best = null;
  for (let ci = 0; ci <= 24; ci++) for (let a = 0; a < 24; a++) for (let bq = 0; bq < 24; bq++) {
    const cov = 0.40 + ci * 0.012, dx = a/24, dy = bq/24;
    let deep = 0, n = 0, ksum = 0, land = 0, landDeep = 0, nearK = 0, nearN = 0, midDeep = 0, midN = 0;
    for (const q of pts) { if (!q) continue; const k = kf(den(q[0],q[1],dx,dy), cov); n++; ksum += k;
      if (k > 0.55) deep++;
      if (q[4] > 0.4) { land++; if (k > 0.55) landDeep++;
        if (q[3] > GY*0.62) { nearN++; nearK += k; }                 // near field: keep it lit
        else { midN++; if (k > 0.5) midDeep++; } } }
    const kc = kf(den(capP[0],capP[1],dx,dy), cov);
    const frac = deep/n, lf = landDeep/Math.max(land,1);
    // want ~28% of the board deep, a good share of it ON LAND, mean k mid-range (real gradient
    // in frame, not a binary stencil), and the capital lit.
    const score = -Math.abs(frac-0.22)*5 - kc*3 - (nearK/Math.max(nearN,1))*3.5
                  + Math.min(midDeep/Math.max(midN,1), 0.45)*3.0 - Math.abs(ksum/n-0.24)*2;
    if (!best || score > best.score) best = { cov:+cov.toFixed(3), dx:+dx.toFixed(3), dy:+dy.toFixed(3), frac:+frac.toFixed(3), landFrac:+lf.toFixed(3), kCap:+kc.toFixed(3), meanK:+(ksum/n).toFixed(3), score:+score.toFixed(3) };
  }
  const rows = [];
  for (let sy = 0; sy < GY; sy++) { let r = '';
    for (let sx = 0; sx < GX; sx++) { const q = pts[sy*GX+sx];
      if (!q) { r += ' '; continue; }
      const k = kf(den(q[0],q[1],best.dx,best.dy), best.cov);
      r += ' .:-=+*#%@'[Math.min(9, Math.floor(k*10))]; }
    rows.push(r); }
  return { best, fieldRange: [+lo.toFixed(3), +hi.toFixed(3)], W, rows };
});
console.log(JSON.stringify(r.best), 'fieldRange', r.fieldRange, 'W', r.W);
console.log(r.rows.join('\n'));
await b.close();
