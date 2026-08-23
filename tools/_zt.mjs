import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:400,height:225}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.water&&window.camera,null,{timeout:120000});
console.log(JSON.stringify(await p.evaluate(()=>window.scene.children.map(o=>({n:o.name,t:o.type,c:o.children.length,uuid:o.uuid.slice(0,6),isTerr:o===window.terrain?.group,isU:o===window.units?.group})))));
await b.close();
