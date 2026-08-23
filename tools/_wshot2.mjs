// HMR-proof capture. Four agents edit this repo in parallel and every save full-reloads the
// Vite page, which destroys the execution context mid-wait — that is what made every capture in
// this window come back blank or throw. Retry around it, and count frames since the LAST load.
import { chromium } from 'playwright';
const [,,out='shots/x.png', W='1600', H='900', frames='30', hideFx='0'] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:+W,height:+H}});
const errs=[]; p.on('pageerror',e=>errs.push(String(e).slice(0,200)));
let reloads=0; p.on('framenavigated',f=>{ if(f===p.mainFrame()) reloads++; });
const deadline=Date.now()+40*60*1000;
let ok=false;
for (let attempt=0; attempt<24 && Date.now()<deadline && !ok; attempt++) {
  try {
    await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
    // __frameCount resets on every reload, so "fc >= n" already means "n frames since the last
    // load". Nothing to reject: only a reload between the wait and the shutter matters, and that
    // throws, which the retry catches.
    await p.waitForFunction(n=>(window.__frameCount||0)>=n, +frames, {timeout: Math.max(30000, Math.min(420000, deadline-Date.now()))});
    if (hideFx==='1') { await p.evaluate(()=>{ if(window.fx) window.fx.group.visible=false; }); await p.waitForFunction(n=>(window.__frameCount||0)>=n, +frames+14, {timeout:600000}); }
    await p.screenshot({path:out, timeout:180000});
    ok=true;
  } catch (e) { errs.push('retry: '+String(e).slice(0,120)); }
}
const { statSync } = await import('node:fs');
const bytes = ok ? statSync(out).size : 0;
console.log(JSON.stringify({out, ok, bytes, blank: bytes<20000, reloads, fps: await p.evaluate(()=>window.__fps).catch(()=>null), errors: errs.slice(0,6)}));
await b.close();
