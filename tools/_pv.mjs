// live post/grid variant sweep: one page load, N uniform sets, gate metrics for each.
// usage: node tools/_pv.mjs '[{"name":"base"},{"name":"b","post":{"uBlur":0.8}}]'
// keys: post.* -> present uniforms, grade.* -> grade uniforms, grid.* -> grid uniforms
import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const variants = JSON.parse(process.argv[2] || '[{"name":"base"}]');
const F = +(process.env.F || 14);
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const errs = []; p.on('pageerror', e => errs.push(String(e).slice(0,200)));
p.on('console', m => { if (m.type()==='error' && !/favicon|Failed to load resource/.test(m.text())) errs.push(m.text().slice(0,200)); });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 60000 });
const wait = () => p.waitForFunction(n => (window.__frameCount||0) >= n, F, { timeout: 300000 }).catch(()=>{});
await wait();
const REG = [ {x:60,y:90,w:240,h:160,name:'far-cliff'}, {x:380,y:380,w:240,h:160,name:'mid'},
              {x:700,y:700,w:240,h:160,name:'near-field'}, {x:1150,y:200,w:240,h:160,name:'water'} ];
for (const v of variants) {
  await p.evaluate(v => {
    const set = (o, m) => { for (const k in (m||{})) { const u = o[k]; if (!u) { console.warn('no uniform', k); continue; }
      if (u.value && u.value.isVector2) u.value.set(m[k][0], m[k][1]); else if (u.value && u.value.isVector3) u.value.set(m[k][0], m[k][1], m[k][2]); else u.value = m[k]; } };
    set(window.post._mPresent.uniforms, v.post);
    set(window.post.grade.uniforms, v.grade);
    if (window.input?.grid) set(window.input.grid.uniforms, v.grid);
    window.post._frame = 0; window.__frameCount = 0;
  }, v);
  await wait();
  const png = 'data:image/png;base64,' + (await p.screenshot({ timeout: 180000 })).toString('base64');
  const out = await p.evaluate(async ({png, REG}) => {
    const img = new Image(); img.src = png; await img.decode();
    const c = document.createElement('canvas'); c.width=img.width; c.height=img.height;
    const g = c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
    const full = g.getImageData(0,0,c.width,c.height).data;
    const lum = new Float32Array(c.width*c.height);
    for (let i=0,j=0;i<full.length;i+=4,j++) lum[j]=0.2126*full[i]+0.7152*full[i+1]+0.0722*full[i+2];
    const box=(r,x,y,W,H)=>{let s=0,n=0;for(let dy=-r;dy<=r;dy++)for(let dx=-r;dx<=r;dx++){const xx=x+dx,yy=y+dy;if(xx<0||yy<0||xx>=W||yy>=H)continue;s+=lum[yy*W+xx];n++;}return s/n;};
    const stats=[];
    for (const R of REG) { let hf=0,mid=0,n=0,L=0,S=0;
      for(let y=R.y;y<R.y+R.h;y++)for(let x=R.x;x<R.x+R.w;x++){ if(x<1||y<1||x>=c.width-1||y>=c.height-1)continue;
        const i=y*c.width+x,l=lum[i];
        hf+=Math.pow(l-box(1,x,y,c.width,c.height),2);
        mid+=Math.pow(box(2,x,y,c.width,c.height)-box(8,x,y,c.width,c.height),2);
        const o=i*4,mx=Math.max(full[o],full[o+1],full[o+2]),mn=Math.min(full[o],full[o+1],full[o+2]);
        S+=mx?(mx-mn)/mx:0; L+=l; n++; }
      const HF=Math.sqrt(hf/n), MID=Math.sqrt(mid/n);
      stats.push({name:R.name,mean:+(L/n).toFixed(1),sat:+(S/n).toFixed(3),HF:+HF.toFixed(2),MID:+MID.toFixed(2),r:+(MID/HF).toFixed(2)});}
    let cr=0,bl=0; for(let i=0;i<lum.length;i++){if(lum[i]<4)cr++;if(lum[i]>250)bl++;}
    return {crushed:+(100*cr/lum.length).toFixed(2),blown:+(100*bl/lum.length).toFixed(2),regions:stats};
  }, {png, REG});
  const nf = out.regions.find(r=>r.name==='near-field'), fc = out.regions.find(r=>r.name==='far-cliff');
  out.ramp = +(nf.HF/fc.HF).toFixed(2);
  console.log(v.name.padEnd(10), JSON.stringify(out.regions.map(r=>`${r.name} m${r.mean} s${r.sat} HF${r.HF} MID${r.MID} r${r.r}`)), 'ramp', out.ramp, 'crush', out.crushed, 'blown', out.blown);
}
if (errs.length) console.log('ERRORS', JSON.stringify([...new Set(errs)].slice(0,6)));
await b.close();
