// node tools/_wline.mjs in.png x0 y0 x1 y1 n  -> RGB along a line
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [, , inp, x0, y0, x1, y1, n = '40'] = process.argv;
const b64 = readFileSync(inp).toString('base64');
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const p = await b.newPage(); await p.setContent('<canvas id=c></canvas>');
console.log(await p.evaluate(async ([b64,x0,y0,x1,y1,n]) => {
  const img = new Image(); await new Promise(r=>{img.onload=r;img.src='data:image/png;base64,'+b64;});
  const c=document.getElementById('c'),g=c.getContext('2d'); c.width=img.width;c.height=img.height;g.drawImage(img,0,0);
  const d=g.getImageData(0,0,img.width,img.height).data; const out=[];
  for(let k=0;k<n;k++){const t=k/(n-1),x=Math.round(x0+(x1-x0)*t),y=Math.round(y0+(y1-y0)*t);
    const i=(y*img.width+x)*4; out.push(`${x},${y}: ${d[i]},${d[i+1]},${d[i+2]}`);}
  return out.join('\n');
}, [b64,+x0,+y0,+x1,+y1,+n]));
await b.close();
