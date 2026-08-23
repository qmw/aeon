import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount || 0) >= 2, null, { timeout: 300000 }).catch(() => {});
console.log(JSON.stringify(await p.evaluate(() => {
  const c = window.camera, T = window.THREE, r = new T.Raycaster(), out = {};
  out.camY = +c.position.y.toFixed(2); out.cam = [c.position.x, c.position.y, c.position.z].map(v => +v.toFixed(1));
  // horizontal ground distance at a few screen points, via the terrain height field
  const hit = (nx, ny) => { const v = new T.Vector3(nx, ny, 0.5).unproject(c).sub(c.position).normalize();
    let t = 1; for (let i = 0; i < 200; i++) { const p2 = c.position.clone().addScaledVector(v, t);
      const h = window.terrain?.heightAt(p2.x, p2.z) ?? 0; if (p2.y <= h + 0.05) return +Math.hypot(p2.x - c.position.x, p2.z - c.position.z).toFixed(1); t += 0.5; } return null; };
  // screen 1600x900 -> ndc
  const P = { 'far-cliff(180,170)': [180, 170], 'mid(500,460)': [500, 460], 'near(820,780)': [820, 780], 'water(1200,280)': [1200, 280] };
  for (const [k, [x, y]] of Object.entries(P)) out[k] = hit(x / 1600 * 2 - 1, -(y / 900 * 2 - 1));
  return out;
}), null, 1));
await b.close();
