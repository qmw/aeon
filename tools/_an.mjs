// node tools/_an.mjs img.png  -> map-region histogram + near/far bands + grid-over-ocean probe
import { chromium } from 'playwright'; import { readFileSync } from 'node:fs';
const f = process.argv[2];
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']}); const p=await br.newPage();
const b64=readFileSync(f).toString('base64');
console.log(JSON.stringify(await p.evaluate(async (b64)=>{
  const im=await new Promise(r=>{const i=new Image();i.onload=()=>r(i);i.src='data:image/png;base64,'+b64;});
  const W=im.width,H=im.height;const c=document.createElement('canvas');c.width=W;c.height=H;
  const g=c.getContext('2d');g.drawImage(im,0,0);const d=g.getImageData(0,0,W,H).data;
  const L=i=>0.299*d[i*4]+0.587*d[i*4+1]+0.114*d[i*4+2];
  const S=i=>{const r=d[i*4],gg=d[i*4+1],b=d[i*4+2];const mx=Math.max(r,gg,b),mn=Math.min(r,gg,b);return mx?(mx-mn)/mx:0;};
  // map region: exclude HUD strips
  const inMap=(x,y)=> y>56 && y<H-6 && !(x>1255&&y<310) && !(x>1280&&y>570) && !(x<400&&y>670);
  const hist=new Array(256).fill(0); let n=0, satSum=0, clip=0;
  for(let y=0;y<H;y++)for(let x=0;x<W;x++){ if(!inMap(x,y))continue; const i=y*W+x; const l=L(i); hist[Math.round(l)]++;n++;satSum+=S(i); if(l>250)clip++; }
  let cum=0,p1=0,p25=0,p50=0,p75=0,p99=0;
  for(let v=0;v<256;v++){cum+=hist[v]; const q=cum/n; if(!p1&&q>=0.01)p1=v; if(!p25&&q>=0.25)p25=v; if(!p50&&q>=0.5)p50=v; if(!p75&&q>=0.75)p75=v; if(!p99&&q>=0.99)p99=v;}
  // horizontal bands of the map area: near(bottom) -> far(top)
  const bands=[];
  for(let k=0;k<6;k++){
    const y0=60+k*Math.floor((H-120)/6), y1=y0+Math.floor((H-120)/6);
    let R=0,G=0,B=0,s=0,m=0;
    for(let y=y0;y<y1;y++)for(let x=420;x<1240;x++){const i=y*W+x;R+=d[i*4];G+=d[i*4+1];B+=d[i*4+2];s+=S(i);m++;}
    bands.push({y:y0,rgb:[R/m|0,G/m|0,B/m|0],lum:+(0.299*R/m+0.587*G/m+0.114*B/m).toFixed(1),sat:+(s/m).toFixed(3)});
  }
  return {n,p1,p25,p50,p75,p99,meanSat:+(satSum/n).toFixed(3),pctOver250:+(100*clip/n).toFixed(3),bands};
},b64)));
await br.close();
