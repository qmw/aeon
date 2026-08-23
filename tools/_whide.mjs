// node tools/_whide.mjs out.png hideExpr [frames]
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,out,expr,frames='6']=process.argv;
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.log('ERR',String(e)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.water&&window.camera,null,{timeout:120000});
await p.evaluate(e=>eval(e), expr);
const n=+frames+ (await p.evaluate(()=>window.__frameCount||0));
await p.waitForFunction(k=>(window.__frameCount||0)>=k,n,{timeout:180000}).catch(()=>{});
await p.screenshot({path:out});
console.log(out);
await b.close();
