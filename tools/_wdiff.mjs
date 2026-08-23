import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,a,b,out]=process.argv;
const A=readFileSync(a).toString('base64'), B=readFileSync(b).toString('base64');
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await br.newPage();
const png=await p.evaluate(async ([A,B])=>{
  const ld=async s=>{const i=new Image();i.src='data:image/png;base64,'+s;await i.decode();return i;};
  const ia=await ld(A), ib=await ld(B);
  const c=document.createElement('canvas');c.width=ia.width;c.height=ia.height;
  const g=c.getContext('2d');g.drawImage(ia,0,0);const da=g.getImageData(0,0,c.width,c.height);
  g.drawImage(ib,0,0);const db=g.getImageData(0,0,c.width,c.height);
  const o=g.createImageData(c.width,c.height);
  for(let i=0;i<da.data.length;i+=4){
    const d=Math.abs(da.data[i]-db.data[i])+Math.abs(da.data[i+1]-db.data[i+1])+Math.abs(da.data[i+2]-db.data[i+2]);
    const v=Math.min(255,d*3); o.data[i]=v;o.data[i+1]=v;o.data[i+2]=v;o.data[i+3]=255;
  }
  g.putImageData(o,0,0);
  return c.toDataURL('image/png').split(',')[1];
},[A,B]);
writeFileSync(out,Buffer.from(png,'base64'));
await br.close();console.log(out);
