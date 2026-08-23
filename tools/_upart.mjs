// units agent: project every part of one unit to screen, so a blown-out blob in a capture can
// be named instead of guessed. node tools/_upart.mjs [screenX screenY] — lists nearest parts.
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [, , SX = 455, SY = 300, D = 5, PT = 45, W = 800, H = 600] = process.argv.map(Number).map((v,i)=>i<2?v:v);
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 800, height: 600 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => window.units && window.units.units.size, null, { timeout: 300000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(([SX, SY]) => {
  const U = window.units, C = window.camera;
  const u = [...U.units.values()].find(x => !x.water && !U._platAt.has(x.q*4096+x.r) && x.type==='warrior');
  const e = 45*Math.PI/180, a = 2.35, D = 5;
  C.position.set(u.x + Math.sin(a)*Math.cos(e)*D, u.y + Math.sin(e)*D, u.z + Math.cos(a)*Math.cos(e)*D);
  C.lookAt(u.x, u.y + 0.45, u.z); C.updateMatrixWorld(true);
  U._step(u, 0.016);
  const V = C.position.constructor;
  const out = [];
  u.def.parts.forEach((pt, i) => {
    const pr = U.prim[pt.g]; const m = new (U.group.matrixWorld.constructor)();
    pr.mesh.getMatrixAt(u.slots[i], m);
    const v = new V().setFromMatrixPosition(m).project(C);
    const sc = new V().setFromMatrixScale(m);
    out.push({ i, g: pt.g, src: typeof pt.c === 'string' ? pt.c : '#'+pt.c.toString(16),
      x: Math.round((v.x*0.5+0.5)*800), y: Math.round((-v.y*0.5+0.5)*600),
      sz: +Math.max(sc.x,sc.y,sc.z).toFixed(3) });
  });
  out.sort((A,B) => Math.hypot(A.x-SX,A.y-SY) - Math.hypot(B.x-SX,B.y-SY));
  return out.slice(0, 10);
}, [SX, SY]), null, 0).replace(/},/g,'},\n'));
await b.close();
