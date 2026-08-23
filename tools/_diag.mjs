// node tools/_diag.mjs <js-expr-to-eval-before-render> <out.png> [frames]
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,expr,out,frames='10']=process.argv;
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.__ready,null,{timeout:180000});
await p.evaluate(e=>{ eval(e); }, expr);
await p.waitForFunction(f=>window.__frameCount>=f,+frames,{timeout:300000});
await p.evaluate(()=>{const h=document.querySelector('#hud'); if(h) h.style.display='none';});
await p.waitForTimeout(1500);
await p.screenshot({path:out});
console.log('ok',out);
await b.close();
