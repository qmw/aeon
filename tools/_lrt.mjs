// read the HDR scene target at given screen pixels (pre-post), plus the graded buffer.
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e).slice(0,200)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=6,null,{timeout:400000}).catch(()=>{});
const pts=process.argv.slice(2).map(s=>s.split(',').map(Number));
const run=async(mode)=>{
 await p.evaluate(m=>{
   if(m==='nofx'&&window.fx)window.fx.group.visible=false;
   if(m==='nowater'&&window.water)window.water.group.visible=false;
   if(m==='nohemi')window.sky.hemi.intensity=0;
   if(m==='base'){if(window.fx)window.fx.group.visible=true;if(window.water)window.water.group.visible=true;}
 },mode);
 await p.evaluate(()=>new Promise(r=>{const s=window.__frameCount;const t=setInterval(()=>{if(window.__frameCount>s+3){clearInterval(t);r();}},60);}));
 return p.evaluate(pts=>{
  const r=window.renderer,rt=window.post._sceneRT;
  const buf=new Float32Array(4);
  return pts.map(([x,y])=>{
   r.readRenderTargetPixels(rt,x,rt.height-y,1,1,buf);
   const [R,G,B]=[buf[0],buf[1],buf[2]];
   const M=Math.max(R,G,B),m2=Math.min(R,G,B);
   let h=-1;if(M-m2>1e-6){h=M===R?60*(((G-B)/(M-m2))%6):M===G?60*((B-R)/(M-m2)+2):60*((R-G)/(M-m2)+4);if(h<0)h+=360;}
   return {at:[x,y],lin:[R,G,B].map(v=>+v.toFixed(4)),hue:+h.toFixed(0),br:+(B/Math.max(R,1e-6)).toFixed(2)};
  });
 },pts);
};
for(const m of ['base','nofx','nowater','nohemi']) console.log(m, JSON.stringify(await run(m)));
await b.close();
