import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(() => (window.__frameCount||0) >= 2, null, { timeout: 240000 }).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const T = window.THREE, cam = window.camera, terr = window.terrain;
  const rc = new T.Raycaster(); const objs = [];
  terr.group.traverse(o => { if ((o.isMesh||o.isInstancedMesh) && /surface|ridges|scree/.test(o.name)) objs.push(o); });
  const hit = (px,py)=>{ rc.setFromCamera(new T.Vector2(px/800-1,1-py/450), cam); const r = rc.intersectObjects(objs,false); return r.length?r[0]:null; };
  const scan = (X,Y,W,H) => {
    const iso = [], mm = [], names = {};
    const dx = new T.Vector3(), dy = new T.Vector3(), cr = new T.Vector3();
    for (let y=Y+4;y<Y+H;y+=7) for (let x=X+4;x<X+W;x+=7) {
      const a=hit(x,y), b1=hit(x+1,y), b2=hit(x,y+1); if(!a||!b1||!b2) continue;
      dx.subVectors(b1.point,a.point); dy.subVectors(b2.point,a.point);
      const area = cr.crossVectors(dx,dy).length(), lng = Math.max(dx.length(), dy.length());
      if (lng < 1e-9) continue;
      iso.push((area/lng)/lng); mm.push(lng);
      names[a.object.name]=(names[a.object.name]||0)+1;
    }
    iso.sort((p,q)=>p-q); mm.sort((p,q)=>p-q);
    const q=(v,f)=>+v[Math.floor(f*(v.length-1))].toFixed(4);
    return { n: iso.length, iso: [q(iso,0.1),q(iso,0.5),q(iso,0.9)], mpp: [q(mm,0.1),q(mm,0.5),q(mm,0.9)], objs: names };
  };
  return { far: scan(60,90,240,160), mid: scan(380,380,240,160), near: scan(700,700,240,160), cliffTop: scan(120,120,160,120) };
}), null, 1));
await b.close();
