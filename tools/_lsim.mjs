import { grade } from './_lcurve2.mjs';
const LW=[0.2126,0.7152,0.0722];const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const PI=Math.PI;
const O=JSON.parse(process.argv[2]||'{}');
const sunI=O.sunI??6.73, hemiI=O.hemiI??0.56;
const sunCol=[1,0.845,0.72];   // normalised warm key (sky.js s/max)
const sky=[0.70,0.735,0.80], gnd=[0.48,0.375,0.25];
const alb={sand:[0.62,0.52,0.36],grass:[0.24,0.34,0.14],stone:[0.55,0.51,0.46]};
const rows=[];
for(const [nm,a] of Object.entries(alb)){
 for(const [cs,ndl,upness] of [['lit-ground',0.616,1.0],['lit-slope',0.35,0.85],['shadowed-ground',0,1.0],['camwall(unlit)',0,0.5],['AO deep',0,0.35]]){
  const amb=sky.map((s,i)=>(gnd[i]+(s-gnd[i])*(0.5+0.5*upness))*hemiI);
  const lin=a.map((al,i)=>(sunI*ndl*sunCol[i]+amb[i])*al/PI);
  const d=grade(lin,O);
  rows.push([nm+'/'+cs, lin.map(v=>v.toFixed(3)).join(','), d.map(v=>Math.round(v*255)).join(','), dot(d,LW).toFixed(3)]);
 }
}
for(const r of rows) console.log(r[0].padEnd(24),'lin',r[1].padEnd(20),'->',r[2].padEnd(14),'L',r[3]);
