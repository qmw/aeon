import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const b64=readFileSync(process.argv[2]).toString('base64');
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await br.newPage();
const out=await p.evaluate(async(url)=>{
 const img=new Image(); img.src=url; await img.decode();
 const c=document.createElement('canvas'); c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const W=c.width,H=c.height;
 // UI mask: top bar y<50; notif rail x>1265 && y<300; unit panel x<400 && y>672; endturn+minimap x>1290 && y>595
 const ui=(x,y)=> y<52 || (x>1265&&y<300) || (x<402&&y>672) || (x>1288&&y>592);
 const cell=100, rows=[];
 for(let cy=0;cy<H;cy+=cell){ const row=[];
  for(let cx=0;cx<W;cx+=cell){ let s=0,n=0;
   for(let y=cy;y<Math.min(cy+cell,H);y++)for(let x=cx;x<Math.min(cx+cell,W);x++){ if(ui(x,y))continue; const o=(y*W+x)*4; s+=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]; n++; }
   row.push(n>cell*cell*0.4? Math.round(s/n): null);
  } rows.push(row);
 }
 // global luminance histogram of non-UI pixels + crushed/blown on non-UI
 let crushed=0,blown=0,tot=0; const hist=new Array(32).fill(0);
 let sumSatLand=0,nLand=0;
 for(let y=0;y<H;y++)for(let x=0;x<W;x++){ if(ui(x,y))continue; const o=(y*W+x)*4;
  const l=0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]; tot++; hist[Math.min(31,Math.floor(l/8))]++;
  if(l<12)crushed++; if(l>243)blown++; }
 return {rows, crushedPctNonUI:+(100*crushed/tot).toFixed(3), blownPctNonUI:+(100*blown/tot).toFixed(3), hist};
},'data:image/png;base64,'+b64);
console.log('luma grid (100px cells, UI masked):');
out.rows.forEach((r,i)=>console.log(String(i*100).padStart(4)+' '+r.map(v=>v===null?'  --':String(v).padStart(4)).join('')));
console.log('crushed<12:',out.crushedPctNonUI+'%','blown>243:',out.blownPctNonUI+'%');
console.log('hist(bins of 8):',out.hist.join(','));
await br.close();
