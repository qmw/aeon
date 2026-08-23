import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await b.newPage();
console.log(JSON.stringify(await p.evaluate(async u=>{
 const img=new Image(); img.src=u; await img.decode();
 const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const CW=16, CH=9, grid=[]; for(let j=0;j<CH;j++){const row=[];for(let i=0;i<CW;i++)row.push(0);grid.push(row);}
 let tot=0;
 for(let y=0;y<c.height;y++)for(let x=0;x<c.width;x++){const o=(y*c.width+x)*4;
  const L=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2];
  if(L>250){tot++;grid[Math.floor(y/(c.height/CH))][Math.floor(x/(c.width/CW))]++;}}
 return {tot, grid};
}, 'data:image/png;base64,'+readFileSync(process.argv[2]).toString('base64'))).replace(/\],\[/g,'],\n['));
await b.close();
