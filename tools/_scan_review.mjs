import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b64=readFileSync(process.argv[2]).toString('base64');
const segs=JSON.parse(process.argv[3]);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await br.newPage();
const out=await p.evaluate(async({url,segs})=>{
 const img=new Image(); img.src=url; await img.decode();
 const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data; const W=c.width;
 return segs.map(S=>{
  // average N stacked rows to kill noise, then find the deepest dip vs local median
  const prof=[];
  for(let i=0;i<S.len;i++){ let s=0;
   for(let k=0;k<(S.rows||3);k++){ const o=((S.y+k)*W+(S.x+i))*4; s+=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]; }
   prof.push(s/(S.rows||3)); }
  const sorted=[...prof].sort((a,b)=>a-b); const med=sorted[Math.floor(sorted.length/2)];
  const mn=Math.min(...prof); const mnAt=prof.indexOf(mn);
  return {name:S.name, median:+med.toFixed(1), min:+mn.toFixed(1), dip:+(med-mn).toFixed(1), dipPctOfMedian:+(100*(med-mn)/med).toFixed(1), atX:S.x+mnAt, profile:prof.map(v=>Math.round(v)).join(' ')};
 });
},{url:'data:image/png;base64,'+b64,segs});
console.log(JSON.stringify(out,null,1));
await br.close();
