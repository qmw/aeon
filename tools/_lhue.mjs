// Where is the violet? Histogram hue over the board area, and map magenta pixels.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const file=resolve(process.argv[2]||'shots/final-hero.png');
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const out=await p.evaluate(async({url})=>{
 const img=new Image();img.src=url;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const D=g.getImageData(0,0,c.width,c.height);const d=D.data;
 const hueOf=(r,g2,b2)=>{const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2),df=M-m;if(df<1e-6)return -1;
  let h=M===r?60*(((g2-b2)/df)%6):M===g2?60*((b2-r)/df+2):60*((r-g2)/df+4);if(h<0)h+=360;return h;};
 const bins=new Array(36).fill(0); let tot=0; const mag=[];
 // board area only: skip HUD strips
 for(let y=60;y<c.height-120;y++)for(let x=0;x<c.width;x++){
  if(x>1250&&y<300)continue; if(x>1280&&y>560)continue; if(x<400&&y>670)continue;
  const o=(y*c.width+x)*4;const r=d[o]/255,g2=d[o+1]/255,b2=d[o+2]/255;
  const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2); if(M-m<0.03)continue;
  const h=hueOf(r,g2,b2); if(h<0)continue; bins[Math.floor(h/10)]++;tot++;
  if(h>250&&h<340) mag.push([x,y]);
 }
 // centroid clusters of magenta
 let cx=0,cy=0; for(const [x,y] of mag){cx+=x;cy+=y;}
 // paint magenta map
 for(let i=0;i<d.length;i+=4){const r=d[i]/255,g2=d[i+1]/255,b2=d[i+2]/255;const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2);
  const h=hueOf(r,g2,b2); const isv=(M-m>0.03)&&h>250&&h<340;
  if(isv){d[i]=255;d[i+1]=0;d[i+2]=255;} else {const l=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];d[i]=d[i+1]=d[i+2]=l*0.5;}}
 g.putImageData(D,0,0);
 return {tot, pct:bins.map((v,i)=>[i*10,+(100*v/tot).toFixed(2)]).filter(z=>z[1]>0.5),
  magentaPct:+(100*mag.length/tot).toFixed(2), magCentroid:mag.length?[Math.round(cx/mag.length),Math.round(cy/mag.length)]:null,
  url:c.toDataURL('image/png')};
},{url:'data:image/png;base64,'+readFileSync(file).toString('base64')});
writeFileSync('/home/piotr/looping_opus_5_test/shots/_lviolet.png',Buffer.from(out.url.split(',')[1],'base64'));
delete out.url; console.log(JSON.stringify(out));
await b.close();
