import { chromium } from 'playwright';
const [,,PX='1090',PY='700']=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=4,null,{timeout:300000}).catch(()=>{});
console.log(JSON.stringify(await p.evaluate(([px,py])=>{
  const C=window.camera;const T=window.THREE||window.__THREE;if(!T)return{globals:Object.keys(window).filter(k=>/^(THREE|units|terrain|scene|camera|water|fx|map|input|renderer)/.test(k))};
  const rc=new T.Raycaster();
  rc.setFromCamera(new T.Vector2((px/1600)*2-1, -((py/900)*2-1)), C);
  const hits=rc.intersectObjects(window.scene.children,true);
  return hits.slice(0,6).map(h=>({n:h.object.name||h.object.type,par:h.object.parent?.name||'',d:+h.distance.toFixed(2),inst:h.instanceId??null}));
}),[+PX,+PY]),null,1);
await b.close();
