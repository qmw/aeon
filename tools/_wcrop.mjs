import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [,, file, spec, out, zoom='2'] = process.argv;
const [x,y,w,h] = spec.split(',').map(Number);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p = await b.newPage();
const d = await p.evaluate(async ({url,x,y,w,h,z}) => {
  const img=new Image(); img.src=url; await img.decode();
  const c=document.createElement('canvas'); c.width=w*z; c.height=h*z;
  const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.drawImage(img,x,y,w,h,0,0,w*z,h*z);
  return c.toDataURL('image/png');
}, {url:'data:image/png;base64,'+readFileSync(file).toString('base64'),x,y,w,h,z:+zoom});
writeFileSync(out, Buffer.from(d.split(',')[1],'base64'));
await b.close();
