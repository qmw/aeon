// terrain-agent perf probe: node tools/tfps.mjs  -> steady-state ms/frame
import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
for (let i=0;i<4;i++){ await p.waitForTimeout(6000); console.log(i, JSON.stringify(await p.evaluate(()=>({fps:window.__fps,mspf:window.__mspf})))); }
await b.close();
