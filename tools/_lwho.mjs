// what is at these screen points? raycast the scene at the hero framing.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e).slice(0,200)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=5,null,{timeout:400000}).catch(()=>{});
const pts=process.argv.slice(2).map(s=>s.split(',').map(Number));
console.log(JSON.stringify(await p.evaluate(pts=>{
 const T=window.THREE,cam=window.camera;
 const rc=new T.Raycaster();rc.far=2000;
 return pts.map(([x,y])=>{
  rc.setFromCamera(new T.Vector2(x/1600*2-1,-(y/900*2-1)),cam);
  const hits=rc.intersectObjects(window.scene.children,true).filter(h=>h.object.visible&&h.object.material&&!h.object.material.depthWrite===false);
  const h=hits[0];
  if(!h)return {at:[x,y],hit:null};
  let root=h.object,chain=[];while(root){chain.push(root.name||root.type);root=root.parent;}
  return {at:[x,y],obj:h.object.name||h.object.type,mat:h.object.material.type,
   dist:+h.distance.toFixed(1),y:+h.point.y.toFixed(2),chain:chain.slice(0,4).join('<')};
 });
},pts)));
await b.close();
