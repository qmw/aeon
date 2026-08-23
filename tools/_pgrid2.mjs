// scratch(post): sample the framebuffer across a territory-border edge and across a bare seam.
// Prints a luma/RGB profile perpendicular to the edge, so "is the stroke there and how strong"
// stops being a question you answer by squinting at a 4x crop.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const W = 800, H = 450;
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: W, height: H } });
p.on('pageerror', e => console.log('ERR', String(e).slice(0,400)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(n => (window.__frameCount||0) >= n, +(process.env.F||14), { timeout: 300000 }).catch(()=>{});
// where do the border edges land on screen?
const spots = await p.evaluate(() => {
  const T = window.THREE, g = window.input.grid, st = g.state, map = window.map, cam = window.camera;
  const A2W = (q, r) => ({ x: 1.5 * q, z: Math.sqrt(3) * (r + q / 2) });
  const out = { border: [], seam: [] };
  const v = new T.Vector3();
  const EDGE_DIR = [0, 5, 4, 3, 2, 1];
  const DIRS = [{q:1,r:0},{q:1,r:-1},{q:0,r:-1},{q:-1,r:0},{q:-1,r:1},{q:0,r:1}];
  for (const t of map.tiles) {
    const bm = st[t.i*4+3]; const c = A2W(t.q, t.r);
    for (let e = 0; e < 6; e++) {
      const th = (e + 0.5) * Math.PI / 3;
      const mx = c.x + Math.cos(th) * 0.866, mz = c.z + Math.sin(th) * 0.866;
      const y = window.terrain?.heightAt(mx, mz) ?? 0;
      if (y <= 0.16) continue;
      v.set(mx, y, mz).project(cam);
      if (Math.abs(v.x) > 0.82 || Math.abs(v.y) > 0.82 || v.z > 1) continue;
      const sx = Math.round((v.x*0.5+0.5) * innerWidth), sy = Math.round((1-(v.y*0.5+0.5)) * innerHeight);
      const rec = { sx, sy, ang: +(th*180/Math.PI).toFixed(0) };
      if (bm & (1<<e)) { if (out.border.length < 6) out.border.push(rec); }
      else if (out.seam.length < 6 && st[t.i*4+3] === 0 && st[t.i*4+2] === 0) out.seam.push(rec);
    }
  }
  return out;
});
const buf = await p.screenshot();
const png = 'data:image/png;base64,' + buf.toString('base64');
console.log(JSON.stringify(await p.evaluate(async ({ png, spots }) => {
  const img = new Image(); img.src = png; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const at = (x, y) => { const o = (y*c.width+x)*4; return [d[o], d[o+1], d[o+2]]; };
  const prof = s => { const th = s.ang * Math.PI/180, nx = Math.cos(th), ny = -Math.sin(th), r = [];
    for (let k = -5; k <= 5; k++) r.push(at(Math.round(s.sx+nx*k), Math.round(s.sy+ny*k)).map(v=>v).join('/'));
    return { at: [s.sx, s.sy], prof: r }; };
  return { border: spots.border.map(prof), seam: spots.seam.map(prof) };
}, { png, spots }), null, 1));
await b.close();
