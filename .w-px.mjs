import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const [,,inp,x,y,w,h,TH]=process.argv;
const b64=readFileSync(inp).toString('base64');
const br=await chromium.launch({executablePath:EXE,args:['--no-sandbox']});
const p=await br.newPage(); await p.setContent('<canvas>');
console.log(JSON.stringify(await p.evaluate(async ([b64,x,y,w,h,TH])=>{
  const img=new Image(); await new Promise(r=>{img.onload=r;img.src='data:image/png;base64,'+b64});
  const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
  const g=c.getContext('2d');g.drawImage(img,0,0);
  const d=g.getImageData(x,y,w,h).data;
  const L=new Float32Array(w*h);
  for(let i=0;i<w*h;i++) L[i]=0.2126*d[i*4]+0.7152*d[i*4+1]+0.0722*d[i*4+2];
  let m=0; for(const v of L) m+=v; m/=w*h;
  let sd=0; for(const v of L) sd+=(v-m)*(v-m); sd=Math.sqrt(sd/(w*h));
  // autocorrelation along x and y at lags 1..24
  const ac=(dx,dy)=>{let s=0,n=0;for(let j=0;j<h-dy;j++)for(let i=0;i<w-dx;i++){s+=(L[j*w+i]-m)*(L[(j+dy)*w+i+dx]-m);n++;}return +(s/n/(sd*sd)).toFixed(3);};
  const ax=[],ay=[];
  for(let k=1;k<=24;k++){ax.push(ac(k,0));ay.push(ac(0,k));}
  // bright-pixel run lengths horizontally / vertically at thresh mean+2sd
  const th=TH?+TH:m+1.8*sd; let hr=[],vr=[];
  for(let j=0;j<h;j++){let r=0;for(let i=0;i<w;i++){if(L[j*w+i]>th)r++;else{if(r)hr.push(r);r=0}}if(r)hr.push(r);}
  for(let i=0;i<w;i++){let r=0;for(let j=0;j<h;j++){if(L[j*w+i]>th)r++;else{if(r)vr.push(r);r=0}}if(r)vr.push(r);}
  const avg=a=>a.length?+(a.reduce((s,v)=>s+v,0)/a.length).toFixed(2):0;
  return {mean:+m.toFixed(1),sd:+sd.toFixed(1),acX:ax,acY:ay,hrun:avg(hr),vrun:avg(vr),nh:hr.length,nv:vr.length,
    pctBright:+(100*L.filter(v=>v>th).length/(w*h)).toFixed(2), max:+Math.max(...L).toFixed(0)};
}, [b64,+x,+y,+w,+h,TH]),null,1));
await br.close();
