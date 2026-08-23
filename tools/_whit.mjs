import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=3,null,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const T=window.THREE, cam=window.camera, sc=window.scene;
  const rc=new T.Raycaster(); rc.far=2000;
  const pts=[[1300,320],[1450,200],[1550,150],[1100,150],[990,300],[880,180],[1080,650],[1400,500],[1560,700]];
  const out=[];
  for(const [x,y] of pts){
    rc.setFromCamera(new T.Vector2(x/1600*2-1,-(y/900*2-1)),cam);
    const hs=rc.intersectObjects(sc.children,true).filter(h=>h.object.visible);
    out.push({px:[x,y],hits:hs.slice(0,3).map(h=>({n:h.object.name||h.object.parent?.name||h.object.type,d:+h.distance.toFixed(1),y:+h.point.y.toFixed(2)}))});
  }
  return {camY:+cam.position.y.toFixed(1),camPos:[+cam.position.x.toFixed(1),+cam.position.z.toFixed(1)],out};
}),null,1));
await b.close();
