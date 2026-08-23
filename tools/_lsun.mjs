import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e).slice(0,200)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=5,null,{timeout:400000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(()=>{
 const T=window.THREE,cam=window.camera,sky=window.sky;
 const f=new T.Vector3();cam.getWorldDirection(f);
 const s=sky.sunDir.clone();
 // ground point at screen centre
 const rc=new T.Raycaster();rc.setFromCamera(new T.Vector2(0,0),cam);
 const pl=new T.Plane(new T.Vector3(0,1,0),-1.0);const hit=new T.Vector3();rc.ray.intersectPlane(pl,hit);
 // 3-unit tall pole at hit; where does its shadow tip land, in screen px?
 const top=hit.clone().setY(hit.y+3);
 const tip=top.clone().addScaledVector(s,-3/s.y);
 const pr=v=>{const q=v.clone().project(cam);return [Math.round((q.x*0.5+0.5)*1600),Math.round((1-(q.y*0.5+0.5))*900)];};
 return {cam:cam.position.toArray().map(v=>+v.toFixed(1)),fwd:f.toArray().map(v=>+v.toFixed(3)),
  sunDir:s.toArray().map(v=>+v.toFixed(3)),
  sunElevDeg:+(Math.asin(s.y)*180/Math.PI).toFixed(1),
  fwdDotSun:+f.dot(s).toFixed(3),
  base:pr(hit),poleTop:pr(top),shadowTip:pr(tip),
  shadowLenWorld:+(3/s.y*Math.hypot(s.x,s.z)).toFixed(2),
  // N.L for a wall facing the camera (horizontal component of -fwd)
  NdotL_camFacingWall:+(new T.Vector3(-f.x,0,-f.z).normalize().dot(s)).toFixed(3),
  NdotL_ground:+s.y.toFixed(3),
  sunIntensity:+window.scene.children.find(c=>c.isDirectionalLight).intensity.toFixed(2),
 };
})));
await b.close();
