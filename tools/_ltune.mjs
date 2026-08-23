// Live A/B: load once, apply uniform sets, wait for TAA, screenshot, measure.
// usage: node tools/_ltune.mjs '[{"name":"base"},{"name":"e2","g":{"uExposure":2.0}}]'
import { chromium } from 'playwright';
import { writeFileSync } from 'node:fs';
const VARIANTS = JSON.parse(process.argv[2]);
const W=+(process.env.W||1600), H=+(process.env.H||900), F=+(process.env.F||14);
const EXE='/home/piotr/.cache/ms-playwright/chromium-1208/chrome-linux64/chrome';
const b=await chromium.launch({executablePath:EXE,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--no-sandbox','--disable-dev-shm-usage']});
const p=await b.newPage({viewport:{width:W,height:H}});
p.on('pageerror',e=>console.log('ERR',String(e).slice(0,200)));
await p.goto('http://localhost:5173/',{waitUntil:'load',timeout:60000});
await p.waitForFunction(()=>(window.__frameCount||0)>=8,null,{timeout:400000}).catch(()=>{});
const wait=n=>p.evaluate(k=>new Promise(r=>{const s=window.__frameCount;const t=setInterval(()=>{if(window.__frameCount>s+k){clearInterval(t);r();}},60);}),n);
// scale regions from 1600x900 to this viewport
const S=W/1600;
const PTS=[[Math.round(150*S),Math.round(240*S),'mtnShad'],[Math.round(250*S),Math.round(110*S),'mtnLit'],[Math.round(700*S),Math.round(530*S),'midShad'],[Math.round(880*S),Math.round(300*S),'grass'],[Math.round(1100*S),Math.round(470*S),'shore']];
const R=[[200,120,200,140,'far-rock'],[700,430,200,140,'mid-sand'],[620,760,200,140,'near-sand'],[1150,200,240,160,'water']]
  .map(([x,y,w,h,n])=>({x:Math.round(x*S),y:Math.round(y*S),w:Math.round(w*S),h:Math.round(h*S),name:n}));
const results=[];
for(const V of VARIANTS){
  await p.evaluate(v=>{
    const post=window.post, sky=window.sky, T=window.THREE;
    if(!window.__base){ window.__base={g:{},s:{},sky:{}};
      for(const k in post.grade.uniforms){const val=post.grade.uniforms[k].value;
        window.__base.g[k]=(val&&val.isColor)?val.clone():(val&&val.toArray)?val.toArray():val;}
    }
    // restore
    for(const k in window.__base.g){const u=post.grade.uniforms[k];const bv=window.__base.g[k];
      if(bv&&bv.isColor)u.value.copy(bv); else if(Array.isArray(bv)&&u.value?.fromArray)u.value.fromArray(bv);
      else if(typeof bv==='number')u.value=bv;}
    if(v.g)for(const k in v.g){const u=post.grade.uniforms[k];const nv=v.g[k];
      if(Array.isArray(nv)){ if(u.value.isColor)u.value.setRGB(nv[0],nv[1],nv[2]); else u.value.fromArray(nv);} else u.value=nv;}
    if(v.p)for(const k in v.p){window.post._mPresent.uniforms[k].value=v.p[k];}
    if(v.hemi!==undefined)sky.hemi.intensity=v.hemi;
    if(v.hemiSky)sky.hemi.color.setRGB(...v.hemiSky);
    if(v.hemiGnd)sky.hemi.groundColor.setRGB(...v.hemiGnd);
    if(v.sunI!==undefined)sky.sun.intensity=v.sunI;
    if(v.tod!==undefined)sky.setTimeOfDay(v.tod);
    if(!window.__baseFrag){window.__baseFrag=post.grade.fragmentShader;window.__basePres=post._mPresent.fragmentShader;}
    let fs=window.__baseFrag, ps=window.__basePres;
    if(v.sed)for(const [a,bb] of v.sed){ if(!fs.includes(a))throw new Error('sed miss: '+a); fs=fs.split(a).join(bb); }
    if(v.sedP)for(const [a,bb] of v.sedP){ if(!ps.includes(a))throw new Error('sedP miss: '+a); ps=ps.split(a).join(bb); }
    if(fs!==post.grade.fragmentShader){post.grade.fragmentShader=fs;post.grade.needsUpdate=true;}
    if(ps!==post._mPresent.fragmentShader){post._mPresent.fragmentShader=ps;post._mPresent.needsUpdate=true;}
    if(v.noShadow)window.scene.traverse(o=>{if(o.isDirectionalLight)o.castShadow=false;});
    if(v.castAll)window.scene.traverse(o=>{if((o.isMesh||o.isInstancedMesh)&&o.material&&!o.material.transparent&&o.name!=='')o.castShadow=true;});
    post._frame=0;
  },V);
  await wait(F);
  const buf=await p.screenshot({type:'png'});
  if(V.save)writeFileSync(V.save,buf);
  const m=await p.evaluate(async ({url,regions,pts})=>{
    const img=new Image();img.src=url;await img.decode();
    const c=document.createElement('canvas');c.width=img.width;c.height=img.height;
    const g=c.getContext('2d',{willReadFrequently:true});g.drawImage(img,0,0);
    const d=g.getImageData(0,0,c.width,c.height).data;
    const lum=new Float32Array(c.width*c.height);
    for(let i=0,j=0;i<d.length;i+=4,j++)lum[j]=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];
    const hueOf=(r,g2,b2)=>{const M=Math.max(r,g2,b2),m2=Math.min(r,g2,b2),df=M-m2;if(df<1e-6)return -1;
      let h=M===r?60*(((g2-b2)/df)%6):M===g2?60*((b2-r)/df+2):60*((r-g2)/df+4);if(h<0)h+=360;return h;};
    const out=[];let crushed=0,blown=0;
    for(let i=0;i<lum.length;i++){if(lum[i]<4)crushed++;if(lum[i]>250)blown++;}
    for(const Rg of regions){
      const px=[];let S2=0,n=0,hx=0,hy=0,hn=0;
      for(let y=Rg.y;y<Rg.y+Rg.h;y++)for(let x=Rg.x;x<Rg.x+Rg.w;x++){
        const o=(y*c.width+x)*4;const L=lum[y*c.width+x];px.push([d[o],d[o+1],d[o+2],L]);
        const M=Math.max(d[o],d[o+1],d[o+2]),m2=Math.min(d[o],d[o+1],d[o+2]);S2+=M?(M-m2)/M:0;n++;
        if(M-m2>8){const h=hueOf(d[o]/255,d[o+1]/255,d[o+2]/255);hx+=Math.cos(h*Math.PI/180);hy+=Math.sin(h*Math.PI/180);hn++;}}
      px.sort((a,b2)=>a[3]-b2[3]);const q=Math.max(1,Math.floor(px.length*0.18));
      const ag=a=>{let L=0,hx2=0,hy2=0,k=0;for(const t of a){L+=t[3];const h=hueOf(t[0]/255,t[1]/255,t[2]/255);if(h>=0){hx2+=Math.cos(h*Math.PI/180);hy2+=Math.sin(h*Math.PI/180);k++;}}
        let hu=k?Math.atan2(hy2/k,hx2/k)*180/Math.PI:-1;if(hu<0&&k)hu+=360;return {L:+(L/a.length/255).toFixed(3),hue:+hu.toFixed(1)};};
      const lo=ag(px.slice(0,q)),hi=ag(px.slice(-q));
      let dh=Math.abs(hi.hue-lo.hue);if(dh>180)dh=360-dh;
      let mean=0;for(const t of px)mean+=t[3];
      out.push({name:Rg.name,mean:+(mean/px.length).toFixed(1),sat:+(S2/n).toFixed(3),
        shadowL:lo.L,litL:hi.L,dL:+(hi.L-lo.L).toFixed(3),dHue:+dh.toFixed(1)});
    }
    const P=[];
    for(const [x,y,nm] of pts){let r=0,g2=0,b2=0,k=0;
      for(let j=y-6;j<=y+6;j++)for(let i=x-6;i<=x+6;i++){const o=(j*c.width+i)*4;r+=d[o];g2+=d[o+1];b2+=d[o+2];k++;}
      r/=k;g2/=k;b2/=k;const M=Math.max(r,g2,b2),m2=Math.min(r,g2,b2);
      P.push({name:nm,hue:+hueOf(r/255,g2/255,b2/255).toFixed(0),sat:+((M-m2)/(M||1)).toFixed(2),L:+((0.2126*r+0.7152*g2+0.0722*b2)/255).toFixed(2)});}
    return {crushedPct:+(100*crushed/lum.length).toFixed(2),blownPct:+(100*blown/lum.length).toFixed(2),regions:out,pts:P};
  },{url:'data:image/png;base64,'+buf.toString('base64'),regions:R,pts:PTS});
  results.push({name:V.name,...m});
  console.log(V.name.padEnd(12),'crush',String(m.crushedPct).padStart(5),'blown',String(m.blownPct).padStart(5),
    m.regions.map(r=>`${r.name} m${r.mean} s${r.sat} L${r.shadowL}/${r.litL} d${r.dL} h${r.dHue}`).join(' | '),
    '||', m.pts.map(q=>`${q.name} h${q.hue} s${q.sat} L${q.L}`).join(' '));
}
await b.close();
