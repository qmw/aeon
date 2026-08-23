import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errors=[]; p.on('pageerror',e=>errors.push(String(e)));
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
await p.waitForFunction(()=> (window.__frameCount||0) >= 6, null, {timeout:120000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(() => {
  const U = window.units, C = window.camera, T = window.THREE;
  const px = (v)=>[(v.x*.5+.5)*1600, (.5-v.y*.5)*900];
  const out = U.cities.map(c=>{
    const sp=c.plate;
    const a=px(new T.Vector3(c.x-1, c.y, c.z).project(C)), bq=px(new T.Vector3(c.x+1, c.y, c.z).project(C));
    const hexPx = Math.abs(bq[0]-a[0]);
    // sprite half width along camera right
    const p0=new T.Vector3().copy(sp.position);
    const right=new T.Vector3(C.matrixWorld.elements[0],C.matrixWorld.elements[1],C.matrixWorld.elements[2]);
    const s0=px(p0.clone().project(C)), s1=px(p0.clone().add(right.clone().multiplyScalar(sp.scale.x*0.5)).project(C));
    const fullPx=Math.abs(s1[0]-s0[0])*2, frac=sp.material.map?.frac??1;
    return {name:c.name,tier:c.tier,hexPx:+hexPx.toFixed(1),platePx:+(fullPx*frac).toFixed(1),ratio:+(fullPx*frac/hexPx).toFixed(3),
            scaleX:+sp.scale.x.toFixed(3),frac:+frac.toFixed(3),
            dP:+C.position.distanceTo(sp.position).toFixed(2), dG:+C.position.distanceTo(new T.Vector3(c.x,c.y,c.z)).toFixed(2)};
  });
  return {cities:out, cam:[C.position.x,C.position.y,C.position.z].map(v=>+v.toFixed(2)), fov:C.fov};
}), null, 1));
console.log('ERRORS', JSON.stringify(errors.slice(0,5)));
await b.close();
