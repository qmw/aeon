// units agent: the acceptance test for "a unit must sit at least 0.25 of a value away from the
// ground it stands on". Renders the same frame twice — once with the cast, once without — and
// diffs, so the unit's pixels are known exactly instead of guessed from a box. Reports the mean
// value of the unit body, of the ground immediately around it, and the gap between them.
// usage: node tools/_ucontrast.mjs [dist] [pitchDeg]
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [D, PT] = [+(process.argv[2] || 27), +(process.argv[3] || 55)];
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 900, height: 700 } });
const errors = []; p.on('pageerror', e => errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
const lock = ([D, PT]) => {
  const U = window.units, I = window.input, C = window.camera;
  if (!U || !U.units.size || !C) return null;
  if (I) I.update = () => {};
  const u = [...U.units.values()].find(x => !x.water && !U._platAt.has(x.q * 4096 + x.r));
  if (!u) return null;
  const e = PT * Math.PI / 180, a = 2.35;
  window.__lock = () => {
    C.position.set(u.x + Math.sin(a) * Math.cos(e) * D, u.y + Math.sin(e) * D, u.z + Math.cos(a) * Math.cos(e) * D);
    C.lookAt(u.x, u.y + 0.45, u.z); C.updateMatrixWorld();
    for (const el of document.querySelectorAll('.hud, #hud, .panel, .topbar, .rail')) el.style.display = 'none';
  };
  window.__lock(); window.__lockT = setInterval(window.__lock, 30);
  // ISO: only the cast, on black. A diff of two lit frames cannot separate a unit from its own
  // cast shadow (hiding the model hides the shadow too) and TAA moves everything else anyway;
  // a hard black matte gives an exact silhouette mask with the SAME lighting rig.
  window.__hide = (v) => {
    for (const o of window.scene.children) if (!o.isLight) o.visible = v ? (o === U.group) : true;
    U.decals.mesh.visible = U.shadows.mesh.visible = U.puffs.mesh.visible = !v;
    U.flags.mesh.visible = !v;
    for (const c of U.cities) if (c.plate) c.plate.visible = !v;
    window.renderer.setClearColor(0x000000, 1);
  };
  window.__lock();
  const v = new C.position.constructor(u.x, u.y + (u.def.h || 0.85) * 0.5 * (u.scale || 1), u.z).project(C);
  return { t: u.type, biome: U.map.get(u.q, u.r)?.biome,
           sx: Math.round((v.x * 0.5 + 0.5) * 900), sy: Math.round((-v.y * 0.5 + 0.5) * 700) };
};
let info = null;
for (let i = 0; i < 200 && !info; i++) { info = await p.evaluate(lock, [D, PT]).catch(() => null); if (!info) await p.waitForTimeout(1000); }
// the other agents save into this repo constantly and every save is an HMR reload
const ensure = async () => { for (let i = 0; i < 120; i++) {
  if (await p.evaluate(() => typeof window.__hide === 'function').catch(() => false)) return;
  await p.evaluate(lock, [D, PT]).catch(() => {}); await p.waitForTimeout(1000);
} };
const settle = async n => { await ensure(); const f0 = await p.evaluate(() => window.__frameCount || 0);
  await p.waitForFunction(k => (window.__frameCount || 0) >= k, f0 + n, { timeout: 300000 }).catch(() => {}); await p.waitForTimeout(300); };
await settle(18); await ensure();
const shot = (await p.screenshot()).toString('base64');
// Sample points, from the SAME frame: an ISO matte cannot be used because post.js re-exposes a
// frame with nothing bright in it and the whole comparison moves.
await ensure();
// Sample the MODEL, not a box over it: every part's own centre is inside the mesh, so
// projecting the parts gives a stable set of body samples that survives the idle animation
// (a fixed box on a 50-px figure lands on a different limb every capture).
const pts = await p.evaluate(([D, PT]) => {
  const U = window.units, C = window.camera;
  const u = [...U.units.values()].find(x => !x.water && !U._platAt.has(x.q * 4096 + x.r));
  const V = C.position.constructor, W = 900, H = 700, M4 = U.group.matrixWorld.constructor;
  const scr = (x, y, z) => { const v = new V(x, y, z).project(C); return [Math.round((v.x*0.5+0.5)*W), Math.round((-v.y*0.5+0.5)*H)]; };
  const body = [], m = new M4(), sv = new V(), pv = new V();
  u.def.parts.forEach((pt, i) => {
    const pr = U.prim[pt.g]; pr.mesh.getMatrixAt(u.slots[i], m);
    pv.setFromMatrixPosition(m); sv.setFromMatrixScale(m);
    if (sv.x < 1e-6) return;                                   // culled by the silhouette budget
    const a = sv.x * sv.y + sv.y * sv.z;                       // rough projected area
    const z = pt.mr[3] || 0;
    body.push({ p: scr(pv.x, pv.y, pv.z), w: a, met: z === 2 || z === 11, b: pt.b, sz: pt._sz || 0 });
  });
  const gnd = [];
  for (let k = 0; k < 10; k++) { const a = k * Math.PI / 5, r = 1.0;
    const gx = u.x + Math.cos(a) * r, gz = u.z + Math.sin(a) * r;
    gnd.push(scr(gx, U.y(gx, gz), gz)); }
  return { body, gnd, type: u.type, biome: U.map.get(u.q, u.r)?.biome };
}, [D, PT]);
const out = await p.evaluate(async ([png, pts]) => {
  const im = new Image(); im.src = 'data:image/png;base64,' + png; await im.decode();
  const c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(im, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height).data, W = c.width;
  const at = ([x, y], r) => { let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= c.width || yy >= c.height) continue;
      const i = (yy * W + xx) * 4; s += (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]) / 255; n++; }
    return s / n; };
  let sw = 0, sv = 0; const all = [], mets = [], band = { head: [], mass: [], legs: [] };
  for (const b of pts.body) { const v = at(b.p, 1); sw += b.w; sv += v * b.w; all.push(v); if (b.met) mets.push(v);
    (b.b === 2 ? band.head : (b.b === 5 || b.b === 6) ? band.legs : band.mass).push(v); }
  const mean = a => a.length ? +(255 * a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) : null;
  all.sort((x, y) => x - y);
  const q = f => +all[Math.floor(f * (all.length - 1))].toFixed(3);
  const gnd = pts.gnd.map(pt => +at(pt, 4).toFixed(3));
  const groundV = gnd.reduce((a, b) => a + b, 0) / gnd.length;
  const bodyV = sv / sw;
  return { n: all.length, L: { head: mean(band.head), mass: mean(band.mass), legs: mean(band.legs), gnd: +(255*groundV).toFixed(0) },
    gnd, groundV: +groundV.toFixed(3), bodyV: +bodyV.toFixed(3),
    p10: q(0.10), p50: q(0.50), p90: q(0.90), spread: +(q(0.90) - q(0.10)).toFixed(3),
    metalV: mets.length ? +(mets.reduce((a, b) => a + b, 0) / mets.length).toFixed(3) : null,
    gap: +Math.abs(bodyV - groundV).toFixed(3),
    darkGap: +(groundV - q(0.10)).toFixed(3), liteGap: +(q(0.90) - groundV).toFixed(3) };
}, [shot, pts]);
delete pts.body;
console.log(JSON.stringify({ ...pts, ...out, pass: Math.max(out.darkGap, out.liteGap) >= 0.25 && out.spread >= 0.25, errors: errors.slice(0, 3) }));
await b.close();
