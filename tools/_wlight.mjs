import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:640,height:360}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction('window.__ready===true',{timeout:60000});
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(()=>{
  const out={};
  const s=window.scene;
  s.traverse(o=>{ if(o.isDirectionalLight) out.dir={c:o.color.toArray(),i:o.intensity};
                  if(o.isHemisphereLight) out.hemi={sky:o.color.toArray(),gnd:o.groundColor.toArray(),i:o.intensity};
                  if(o.isAmbientLight) out.amb={c:o.color.toArray(),i:o.intensity}; });
  out.sunDir=window.sky?.sunDir?.toArray?.();
  out.sunColor=window.sky?.sunColor?.toArray?.();
  out.haze=window.sky?.hazeColor?.toArray?.();
  out.hazeSun=window.sky?.hazeSun?.toArray?.();
  out.cam={p:window.camera.position.toArray(),y:window.camera.position.y};
  out.exposure=window.post?.grade?.uniforms?.uExposure?.value;
  out.aer=[window.post?.grade?.uniforms?.uAerNear?.value,window.post?.grade?.uniforms?.uAerFar?.value];
  // sample the water's own uniforms
  const wu=window.water?.u; if(wu) out.wu={sun:wu.uSun.value.toArray(),glint:wu.uGlint.value.toArray(),sunCol:wu.uSunCol.value.toArray(),skyHor:wu.uSkyHor.value.toArray(),skyZen:wu.uSkyZen.value.toArray()};
  return out;
})));
await b.close();
