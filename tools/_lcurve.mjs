// Replicate the grade transfer (no fog/ao/cloud) to see lit vs shadow separation.
const LW=[0.2126,0.7152,0.0722];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const mix=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const ss=(e0,e1,x)=>{const t=Math.min(1,Math.max(0,(x-e0)/(e1-e0)));return t*t*(3-2*t);};
function aces(x){
 const IN=[[0.59719,0.35458,0.04823],[0.07600,0.90834,0.01566],[0.02840,0.13383,0.83777]];
 const OUT=[[1.60475,-0.53108,-0.07367],[-0.10208,1.10813,-0.00605],[-0.00327,-0.07276,1.07602]];
 const m=(M,v)=>M.map(r=>r[0]*v[0]+r[1]*v[1]+r[2]*v[2]);
 let y=m(IN,x);
 const a=y.map(v=>v*(v+0.0245786)-0.000090537);
 const b=y.map(v=>v*(0.983729*v+0.432951)+0.238081);
 return m(OUT,a.map((v,i)=>v/b[i])).map(v=>Math.min(1,Math.max(0,v)));
}
const P={exposure:2.98,fill:0.096,skyFill:[0.90,0.93,1.00],sunTint:[1.0,0.79,0.58]};
function grade(col,P2={}){
 const Q={...P,...P2};
 let e=col.map(v=>v*Q.exposure);
 const sl=dot(e,LW);
 const tint=e.map(v=>Math.min(2,Math.max(0,v/Math.max(sl,1e-3))));
 const fillv=mix(Q.skyFill,Q.skyFill.map((v,i)=>v*tint[i]),0.78);
 e=e.map((v,i)=>v+Q.fill*fillv[i]*(1-ss(0,0.44,sl)));
 const pk=Math.max(...e);
 e=mix(e,mix([1,1,1],Q.sunTint,0.35).map(v=>v*dot(e,LW)),ss(0.72,2.00,pk)*0.82);
 let c=aces(e).map(v=>Math.pow(v,0.4545454545));
 c=[Math.pow(c[0],0.938),Math.pow(c[1],0.953),Math.pow(c[2],0.980)];
 c=[c[0]*1.014,c[1]*1.003,c[2]*0.990];
 let ct=c.map(v=>Math.max((v-0.60)*1.18+0.60,0));
 const K=0.820;
 c=ct.map(v=>Math.min(v>=K?1-(1-K)*Math.exp(-(v-K)/(1-K)):v,1));
 c=c.map(v=>v+0.16*v*(1-v));
 let l=dot(c,LW);
 const st=mix([0.993,1.000,1.016],[1.034,1.010,0.964],ss(0.08,0.78,l));
 c=c.map((v,i)=>v*st[i]);
 c=c.map((v,i)=>v+[0.042,0.043,0.050][i]*Math.exp(-l*12));
 return c;
}
// a tan sand albedo under key vs ambient-only
const alb=[0.62,0.52,0.36];
const sunCol=[1,0.80,0.55];
const scenarios=[];
for(const [nm,irr] of [['lit(NdL .75)',0.75*6.73],['lit(NdL .45)',0.45*6.73],['shadow(hemi)',0.42],['deep(hemi*.5)',0.21]]){
 const lin=alb.map((a,i)=>a*sunCol[i]*irr*0.03);  // 0.03 = arbitrary radiance scale
 scenarios.push([nm,lin]);
}
for(const [nm,lin] of scenarios){
 const d=grade(lin); const L=dot(d,LW);
 console.log(nm.padEnd(14), 'lin',lin.map(v=>v.toFixed(3)).join(','), '-> disp', d.map(v=>(v*255).toFixed(0)).join(','), 'L',(L).toFixed(3));
}
