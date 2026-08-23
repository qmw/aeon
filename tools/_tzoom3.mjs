import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, src, out, X,Y,W,H, Z=3] = process.argv;
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const d=await p.evaluate(async ({url,X,Y,W,H,Z})=>{
  const img=new Image(); img.src=url; await img.decode();
  const c=document.createElement('canvas'); c.width=W*Z; c.height=H*Z;
  const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.drawImage(img,X,Y,W,H,0,0,W*Z,H*Z);
  return c.toDataURL('image/png');
},{url:'data:image/png;base64,'+readFileSync(src).toString('base64'),X:+X,Y:+Y,W:+W,H:+H,Z:+Z});
writeFileSync(out, Buffer.from(d.split(',')[1],'base64'));
await b.close(); console.log(out);
