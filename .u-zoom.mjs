// crop+magnify a png:  node .u-zoom.mjs in.png out.png x y w h [scale]
import { chromium } from 'playwright';
import { readFileSync, statSync } from 'node:fs';
const [,,i,o,x,y,w,h,s=3]=process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await b.newPage({viewport:{width:Math.round(+w*+s),height:Math.round(+h*+s)}});
const d='data:image/png;base64,'+readFileSync(i).toString('base64');
await p.setContent(`<body style="margin:0;overflow:hidden;background:#000"><img id=m src="${d}" style="position:absolute;image-rendering:pixelated">`);
await p.evaluate(([x,y,s])=>new Promise(r=>{const m=document.getElementById('m');
  const go=()=>{m.style.width=(m.naturalWidth*s)+'px';m.style.left=(-x*s)+'px';m.style.top=(-y*s)+'px';r()};
  m.complete?go():m.onload=go;}),[+x,+y,+s]);
await p.waitForTimeout(300); await p.screenshot({path:o});
console.log(JSON.stringify({o,bytes:statSync(o).size})); await b.close();
