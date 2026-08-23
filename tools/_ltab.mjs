import { grade } from './_lcurve2.mjs';
const LW=[0.2126,0.7152,0.0722];const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const O=JSON.parse(process.argv[2]||'{}');
const alb=[0.62,0.52,0.36];
console.log('lin(scene)  ->  displayL   (sand albedo, neutral-warm light)');
for(const lin of [0.004,0.008,0.015,0.025,0.04,0.06,0.09,0.14,0.22,0.35,0.55,0.9,1.5]){
 const c=alb.map((a,i)=>lin*a/0.5);
 const d=grade(c,O);
 console.log(String(lin).padEnd(8),'->',dot(d,LW).toFixed(3), d.map(v=>Math.round(v*255)).join(','));
}
