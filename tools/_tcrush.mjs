import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
console.log(JSON.stringify(await p.evaluate(async url=>{
  const img=new Image();img.src=url;await img.decode();
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data;
  const GX=16,GY=9,cell=[];for(let i=0;i<GX*GY;i++)cell.push(0);
  let tot=0;
  for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const o=(y*c.width+x)*4;
    const l=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2];
    if(l<4){cell[Math.floor(y*GY/c.height)*GX+Math.floor(x*GX/c.width)]++;tot++;}}
  const top=cell.map((v,i)=>({v,x:(i%GX)*(c.width/GX),y:Math.floor(i/GX)*(c.height/GY)})).filter(a=>a.v>50).sort((a,b)=>b.v-a.v).slice(0,12);
  return {total:tot,top};
},'data:image/png;base64,'+readFileSync(process.argv[2]).toString('base64'))));
await b.close();
