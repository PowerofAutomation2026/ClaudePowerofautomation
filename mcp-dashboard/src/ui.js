// Single-file live dashboard viewer. No external assets, so it works behind strict firewalls and renders instantly.
export const VIEWER_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Live dashboard</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1b1f24;--mute:#667085;--line:#e4e7ec;--good:#12805c;--bad:#c42b1c;--c0:#2563eb;--c1:#d97706;--c2:#0f9d8a;--c3:#9333ea;--c4:#dc2626;--c5:#64748b}
@media (prefers-color-scheme:dark){:root{--bg:#0f1318;--card:#171c23;--ink:#e8ecf1;--mute:#98a2b3;--line:#2a313b;--good:#3ecf9a;--bad:#ff7a6b;--c0:#5b9bff;--c1:#f5a742;--c2:#35c9b3;--c3:#b57cf5;--c4:#ff7a6b;--c5:#94a3b8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:16px 20px;max-width:1280px;margin:auto;flex-wrap:wrap}
h1{font-size:20px;margin:0}header p{margin:0;color:var(--mute);flex-basis:100%}
.pill{margin-left:auto;display:flex;align-items:center;gap:6px;color:var(--mute);font-size:12px}
.dot{width:8px;height:8px;border-radius:50%;background:var(--bad)}.dot.on{background:var(--good);animation:p 2s infinite}@keyframes p{50%{opacity:.4}}
main{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;padding:0 20px 28px;max-width:1280px;margin:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;min-width:0;transition:box-shadow .4s}
.card.flash{box-shadow:0 0 0 2px var(--c0)}
.card h2{font-size:12px;font-weight:600;color:var(--mute);margin:0 0 8px;text-transform:uppercase;letter-spacing:.04em}
.sub{color:var(--mute);font-size:12px}
.kpi{font-size:34px;font-weight:650;letter-spacing:-.02em}.kpi small{font-size:16px;color:var(--mute);font-weight:500;margin-left:2px}
.delta{font-size:13px;font-weight:600}.delta.good{color:var(--good)}.delta.bad{color:var(--bad)}
svg{width:100%;height:auto;display:block}svg text{fill:var(--mute);font-size:10px}.grid{stroke:var(--line)}
.legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:6px;font-size:12px;color:var(--mute)}.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mute);font-weight:600;position:sticky;top:0;background:var(--card)}
.scroll{max-height:360px;overflow:auto}.text{white-space:pre-wrap}
.empty{max-width:1280px;margin:60px auto;text-align:center;color:var(--mute)}
@media(max-width:900px){main{grid-template-columns:repeat(2,1fr)}.s3,.s4{grid-column:span 2!important}}
@media(max-width:560px){main{grid-template-columns:1fr}.card{grid-column:span 1!important}}
</style></head><body>
<header><h1 id="t">Loading…</h1><span class="pill"><span class="dot" id="dot"></span><span id="st">connecting</span></span><p id="d"></p></header>
<main id="m"></main><div class="empty" id="e" hidden>No widgets yet — ask your agent to add some.</div>
<script>
const q=new URLSearchParams(location.search),id=location.pathname.split('/').pop(),tok=q.get('t')||'';
const C=i=>'var(--c'+(i%6)+')';
const el=(tag,attrs={},...kids)=>{const n=tag==='svg'||attrs.ns?document.createElementNS('http://www.w3.org/2000/svg',tag):document.createElement(tag);for(const[k,v]of Object.entries(attrs)){if(k==='ns')continue;if(k==='class')n.setAttribute('class',v);else n.setAttribute(k,v)}for(const k of kids.flat())n.append(k??'');return n};
const S=(tag,a,...k)=>el(tag,{...a,ns:1},...k);
const fmt=n=>n==null?'–':Math.abs(n)>=1e6?(n/1e6).toFixed(1)+'M':Math.abs(n)>=1e4?(n/1e3).toFixed(1)+'k':(+n.toFixed(2)).toString();
const W=600,H=240,P={l:42,r:10,t:10,b:26};
function scale(series){let lo=Infinity,hi=-Infinity;for(const s of series)for(const v of s.values)if(v!=null){lo=Math.min(lo,v);hi=Math.max(hi,v)}if(lo===Infinity)return[0,1,.25];lo=Math.min(lo,0);if(hi===lo)hi=lo+1;const raw=(hi-lo)/4,mag=Math.pow(10,Math.floor(Math.log10(raw))),f=raw/mag,step=(f<=1?1:f<=2?2:f<=5?5:10)*mag;return[Math.floor(lo/step)*step,Math.ceil(hi/step)*step,step]}
function axes(svg,lo,hi,step,labels,band){const y=v=>H-P.b-(v-lo)/(hi-lo)*(H-P.t-P.b);for(let v=lo;v<=hi+step/1e6;v+=step){svg.append(S('line',{class:'grid',x1:P.l,x2:W-P.r,y1:y(v),y2:y(v)}),S('text',{x:P.l-6,y:y(v)+3,'text-anchor':'end'},fmt(v)))}
 const every=Math.ceil(labels.length/8);labels.forEach((l,i)=>{if(i%every)return;const x=band?P.l+band*(i+.5):P.l+(W-P.l-P.r)*(labels.length<2?.5:i/(labels.length-1));svg.append(S('text',{x,y:H-8,'text-anchor':'middle'},l.length>10?l.slice(0,9)+'…':l))});return y}
function legend(series){return series.length>1?el('div',{class:'legend'},series.map((s,i)=>el('span',{},el('i',{style:'background:'+C(i)}),s.name))):''}
function line(w){const svg=S('svg',{viewBox:'0 0 '+W+' '+H}),[lo,hi,step]=scale(w.series),y=axes(svg,lo,hi,step,w.labels),n=w.labels.length,x=i=>P.l+(W-P.l-P.r)*(n<2?.5:i/(n-1));
 w.series.forEach((s,k)=>{let d='',pen=false;s.values.forEach((v,i)=>{if(v==null){pen=false;return}d+=(pen?'L':'M')+x(i).toFixed(1)+' '+y(v).toFixed(1);pen=true});svg.append(S('path',{d,fill:'none',stroke:C(k),'stroke-width':2,'stroke-linejoin':'round'}));
  if(n<=40)s.values.forEach((v,i)=>{if(v!=null)svg.append(S('circle',{cx:x(i),cy:y(v),r:2.5,fill:C(k)},S('title',{},s.name+' · '+w.labels[i]+': '+v)))})});return[svg,legend(w.series)]}
function bar(w){const svg=S('svg',{viewBox:'0 0 '+W+' '+H}),[lo,hi,step]=scale(w.series),n=w.labels.length,band=(W-P.l-P.r)/Math.max(n,1),y=axes(svg,lo,hi,step,w.labels,band),k=w.series.length,bw=Math.min(36,band*.8/k);
 w.series.forEach((s,j)=>s.values.forEach((v,i)=>{if(v==null)return;const x=P.l+band*(i+.5)-bw*k/2+bw*j,y0=y(Math.max(lo,0)),y1=y(v);svg.append(S('rect',{x,y:Math.min(y0,y1),width:bw-1,height:Math.abs(y0-y1),rx:2,fill:C(j)},S('title',{},s.name+' · '+w.labels[i]+': '+v)))}));return[svg,legend(w.series)]}
function pie(w){const vals=w.series[0].values.map(v=>Math.max(0,v||0)),tot=vals.reduce((a,b)=>a+b,0)||1,svg=S('svg',{viewBox:'0 0 300 180'});let a=-Math.PI/2;const cx=90,cy=90,r=78,r2=46;
 vals.forEach((v,i)=>{const b=a+v/tot*2*Math.PI,big=b-a>Math.PI?1:0,p=(R,t)=>(cx+R*Math.cos(t)).toFixed(1)+' '+(cy+R*Math.sin(t)).toFixed(1);if(v/tot>.9999)svg.append(S('circle',{cx,cy,r:(r+r2)/2,fill:'none',stroke:C(i),'stroke-width':r-r2}));else if(v>0)svg.append(S('path',{d:'M'+p(r,a)+'A'+r+' '+r+' 0 '+big+' 1 '+p(r,b)+'L'+p(r2,b)+'A'+r2+' '+r2+' 0 '+big+' 0 '+p(r2,a)+'Z',fill:C(i)},S('title',{},w.labels[i]+': '+w.series[0].values[i]+' ('+Math.round(v/tot*100)+'%)')));a=b});
 svg.append(S('text',{x:cx,y:cy+4,'text-anchor':'middle',style:'font-size:14px;font-weight:600;fill:var(--ink)'},fmt(tot)));
 w.labels.slice(0,10).forEach((l,i)=>{svg.append(S('rect',{x:190,y:14+i*16,width:9,height:9,rx:2,fill:C(i)}),S('text',{x:204,y:22+i*16},(l.length>14?l.slice(0,13)+'…':l)+' '+Math.round(vals[i]/tot*100)+'%'))});return svg}
function kpi(w){const g=w.goodDirection==='down'?-1:1,d=w.delta;return[el('div',{class:'kpi'},typeof w.value==='number'?fmt(w.value):w.value,w.unit?el('small',{},w.unit):''),d!=null?el('div',{class:'delta '+(d===0?'':d*g>0?'good':'bad')},(d>0?'▲ +':d<0?'▼ ':'')+d):'']}
function table(w){return el('div',{class:'scroll'},el('table',{},el('thead',{},el('tr',{},w.columns.map(c=>el('th',{},c)))),el('tbody',{},w.rows.map(r=>el('tr',{},w.columns.map((_,i)=>el('td',{},String(r[i]??''))))))))}
const R={kpi,line,bar,pie,table,text:w=>el('div',{class:'text'},w.text)};
let prev={};
function render(d){document.title=d.title;t.textContent=d.title;document.getElementById('d').textContent=d.description||'';e.hidden=d.widgets.length>0;
 const next={};m.replaceChildren(...d.widgets.map(w=>{const sig=JSON.stringify(w);next[w.id]=sig;let body;try{body=R[w.type](w)}catch(x){body=el('div',{class:'sub'},'Could not render: '+x.message)}
  const c=el('div',{class:'card s'+(w.span||1),style:'grid-column:span '+(w.span||1)},el('h2',{},w.title),w.subtitle?el('div',{class:'sub'},w.subtitle):'',body);
  if(prev[w.id]&&prev[w.id]!==sig){c.classList.add('flash');setTimeout(()=>c.classList.remove('flash'),900)}return c}));prev=next}
const t=document.getElementById('t'),m=document.getElementById('m'),e=document.getElementById('e'),dot=document.getElementById('dot'),st=document.getElementById('st');
function live(on,msg){dot.classList.toggle('on',on);st.textContent=msg}
fetch('/api/d/'+id+'?t='+encodeURIComponent(tok)).then(r=>r.ok?r.json():Promise.reject(r.status)).then(render).catch(s=>{t.textContent=s===404?'Dashboard not found':'Access denied'});
const es=new EventSource('/events/'+id+'?t='+encodeURIComponent(tok));
es.onopen=()=>live(true,'live');es.onerror=()=>live(false,'reconnecting…');
es.onmessage=ev=>{const d=JSON.parse(ev.data);if(d.deleted){t.textContent='Dashboard deleted';m.replaceChildren();es.close();live(false,'closed');return}render(d);live(true,'live · '+new Date().toLocaleTimeString())};
</script></body></html>`;
