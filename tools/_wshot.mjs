// Robust full-quality shot: waits for N frames, long screenshot timeout, retries.
import { chromium } from 'playwright';
const [,,out='shots/_w.png',w='1600',h='900',frames=process.env.SHOT_FRAMES||'60']=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
for (let a=0;a<4;a++){
  const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
  const p=await b.newPage({viewport:{width:+w,height:+h}});
  const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,200)));
  p.on('console',m=>{if(m.type()==='error'&&!/favicon|Failed to load resource/.test(m.text()))errs.push(m.text().slice(0,200));});
  try{
    await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:90000});
    await p.waitForFunction(n=>(window.__frameCount||0)>=n,+frames,{timeout:900000});
    await p.waitForTimeout(1500);
    await p.screenshot({path:out,timeout:180000});
    const {statSync}=await import('node:fs');
    console.log(JSON.stringify({out,bytes:statSync(out).size,blank:statSync(out).size<20000,errors:errs.slice(0,8)}));
    await b.close(); process.exit(0);
  }catch(e){ console.log('retry',a,String(e).slice(0,90)); await b.close(); }
}
process.exit(1);
