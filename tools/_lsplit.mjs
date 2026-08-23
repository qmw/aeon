// per-region: lit (top luma quartile) vs shadow (bottom quartile) mean RGB, hue, L. Same material.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const file=resolve(process.argv[2]||'shots/final-hero.png');
const regions=process.argv.slice(3).map(s=>{const [r,name]=s.split(':');const [x,y,w,h]=r.split(',').map(Number);return {x,y,w,h,name:name||`${x},${y}`};});
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const out=await p.evaluate(async({url,regions})=>{
 const img=new Image();img.src=url;await img.decode();
 const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
 const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
 const d=g.getImageData(0,0,c.width,c.height).data;
 const hueOf=(r,g2,b2)=>{const M=Math.max(r,g2,b2),m=Math.min(r,g2,b2),df=M-m;if(df<1e-6)return -1;
  let h=M===r?60*(((g2-b2)/df)%6):M===g2?60*((b2-r)/df+2):60*((r-g2)/df+4);if(h<0)h+=360;return h;};
 const res=[];
 for(const R of regions){
  const px=[];
  for(let y=R.y;y<R.y+R.h;y++)for(let x=R.x;x<R.x+R.w;x++){const o=(y*c.width+x)*4;
   px.push([d[o],d[o+1],d[o+2],0.2126*d[o]+0.7152*d[o+1]+0.0722*d[o+2]]);}
  px.sort((a,b2)=>a[3]-b2[3]);
  const q=Math.max(1,Math.floor(px.length*0.18));
  const agg=arr=>{let r=0,g2=0,b2=0,hx=0,hy=0,n=0,L=0;
   for(const q2 of arr){r+=q2[0];g2+=q2[1];b2+=q2[2];L+=q2[3];
    const h=hueOf(q2[0]/255,q2[1]/255,q2[2]/255);if(h>=0){hx+=Math.cos(h*Math.PI/180);hy+=Math.sin(h*Math.PI/180);n++;}}
   let hu=n?Math.atan2(hy/n,hx/n)*180/Math.PI:-1;if(hu<0&&n)hu+=360;
   const k=arr.length;return {rgb:[Math.round(r/k),Math.round(g2/k),Math.round(b2/k)],L:+(L/k/255).toFixed(3),hue:+hu.toFixed(1)};};
  const lo=agg(px.slice(0,q)),hi=agg(px.slice(-q));
  let dh=Math.abs(hi.hue-lo.hue); if(dh>180)dh=360-dh;
  res.push({name:R.name,shadow:lo,lit:hi,dL:+(hi.L-lo.L).toFixed(3),dHue:+dh.toFixed(1)});
 }
 return res;
},{url:'data:image/png;base64,'+readFileSync(file).toString('base64'),regions});
console.log(JSON.stringify(out,null,1));
await b.close();
