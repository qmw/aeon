import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const [file,x,y,w,h,out,scale]=process.argv.slice(2);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const url=await p.evaluate(async({u,x,y,w,h,s})=>{
 const img=new Image();img.src=u;await img.decode();
 const c=document.createElement('canvas');c.width=w*s;c.height=h*s;
 const g=c.getContext('2d');g.imageSmoothingEnabled=false;
 g.drawImage(img,x,y,w,h,0,0,w*s,h*s);return c.toDataURL('image/png');
},{u:'data:image/png;base64,'+readFileSync(file).toString('base64'),x:+x,y:+y,w:+w,h:+h,s:+(scale||2)});
writeFileSync(out,Buffer.from(url.split(',')[1],'base64'));
await b.close();
