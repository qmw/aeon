// Water report: per-region HF/MID/mean/sat, hex colour + hue/sat at region centre, and the
// fraction of region pixels above (region p50 + 70) — the "is there any sun on it" number.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const regions = process.argv.slice(3).map(s => { const [r, name] = s.split(':'); const [x,y,w,h]=r.split(',').map(Number); return {x,y,w,h,name:name||`${x},${y}`}; });
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage();
const out = await p.evaluate(async ({url, regions}) => {
  const img=new Image(); img.src=url; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data, W=c.width,H=c.height;
  const lum=new Float32Array(W*H);
  for(let i=0,j=0;i<d.length;i+=4,j++) lum[j]=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
  const box=(r,x,y)=>{let s=0,n=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=W||yy>=H)continue;s+=lum[yy*W+xx];n++;}return s/n;};
  const res=[];
  for(const R of regions){
    let hf=0,mid=0,n=0,L=0,S=0,rr=0,gg=0,bb=0; const vals=[];
    for(let y=R.y;y<R.y+R.h;y++)for(let x=R.x;x<R.x+R.w;x++){
      if(x<1||y<1||x>=W-1||y>=H-1)continue;
      const i=y*W+x,l=lum[i];
      hf+=Math.pow(l-box(1,x,y),2); mid+=Math.pow(box(2,x,y)-box(8,x,y),2);
      const o=i*4,mx=Math.max(d[o],d[o+1],d[o+2]),mn=Math.min(d[o],d[o+1],d[o+2]);
      S+=mx?(mx-mn)/mx:0; L+=l; n++; vals.push(l); rr+=d[o]; gg+=d[o+1]; bb+=d[o+2];
    }
    vals.sort((a,b)=>a-b);
    const p50=vals[vals.length>>1];
    let hot=0; for(const v of vals) if(v>p50+70) hot++;
    const r0=Math.round(rr/n),g0=Math.round(gg/n),b0=Math.round(bb/n);
    const mx=Math.max(r0,g0,b0),mn=Math.min(r0,g0,b0); let h=0;
    if(mx!==mn){ if(mx===r0)h=60*(((g0-b0)/(mx-mn))%6); else if(mx===g0)h=60*((b0-r0)/(mx-mn)+2); else h=60*((r0-g0)/(mx-mn)+4);} if(h<0)h+=360;
    res.push({name:R.name,mean:+(L/n).toFixed(1),sat:+(S/n).toFixed(3),
      HF:+Math.sqrt(hf/n).toFixed(2),MID:+Math.sqrt(mid/n).toFixed(2),
      'MID/HF':+(Math.sqrt(mid/n)/Math.max(Math.sqrt(hf/n),1e-6)).toFixed(2),
      hex:'#'+[r0,g0,b0].map(v=>v.toString(16).padStart(2,'0')).join(''),
      hue:Math.round(h), satHSV:+((mx-mn)/(mx||1)).toFixed(2), hotPct:+(100*hot/n).toFixed(2)});
  }
  let crushed=0,blown=0; for(let i=0;i<lum.length;i++){if(lum[i]<4)crushed++;if(lum[i]>250)blown++;}
  return {res, crushedPct:+(100*crushed/lum.length).toFixed(2), blownPct:+(100*blown/lum.length).toFixed(2)};
}, {url:'data:image/png;base64,'+readFileSync(file).toString('base64'), regions});
for(const r of out.res) console.log(JSON.stringify(r));
console.log('crushedPct',out.crushedPct,'blownPct',out.blownPct);
await b.close();
