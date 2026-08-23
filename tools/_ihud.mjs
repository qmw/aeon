import { chromium } from 'playwright';
const EXE = '/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const warn=[]; p.on('console', m=>{ if(m.type()==='warning'||m.type()==='error') warn.push(m.type()+': '+m.text().slice(0,140)); });
await p.goto('http://localhost:5173/', { waitUntil: 'load', timeout: 120000 });
await p.waitForTimeout(7000);
const r = await p.evaluate(() => {
  const els = [...document.querySelectorAll('#hud > *, #hud .pl')].filter(e=>e.offsetParent!==null||getComputedStyle(e).position==='fixed');
  const boxes = els.map(e=>{const r=e.getBoundingClientRect(); return {c:e.className||e.id||e.tagName, x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}).filter(b=>b.w>30&&b.h>16);
  const ov=[];
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){const a=boxes[i],c=boxes[j];
    if(a.x<c.x+c.w&&c.x<a.x+a.w&&a.y<c.y+c.h&&c.y<a.y+a.h){ // ignore nesting
      const nest = (a.x<=c.x&&a.y<=c.y&&a.x+a.w>=c.x+c.w&&a.y+a.h>=c.y+c.h)||(c.x<=a.x&&c.y<=a.y&&c.x+c.w>=a.x+a.w&&c.y+c.h>=a.y+a.h);
      if(!nest) ov.push([a.c,c.c]);}}
  const off = boxes.filter(b=>b.x<0||b.y<0||b.x+b.w>1600||b.y+b.h>900).map(b=>[b.c,b.x,b.y,b.w,b.h]);
  return JSON.stringify({ n: boxes.length, overlaps: ov.slice(0,10), offscreen: off.slice(0,10), hudText: document.querySelector('#hud')?.innerText?.length });
});
console.log(r); console.log('warn', JSON.stringify(warn.slice(0,8)));
await b.close();
