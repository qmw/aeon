import { chromium } from 'playwright';
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>window.water&&window.terrain&&(window.__frameCount||0)>2,null,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const out=[];
  for(let dz=-2.5;dz<=2.5;dz+=0.5){ let row='';
    for(let dx=-3;dx<=3;dx+=0.5){ const y=window.terrain.heightAt(70.85+dx,61.02+dz); row+=(y>0.10?'#':(y>-0.3?'+':'.')); }
    out.push(row); }
  return {grid:out, hCentre:+window.terrain.heightAt(70.85,61.02).toFixed(3), sd:+window.water.submergedAt(70.85,61.02).toFixed(2)};
}),null,1));
await b.close();
