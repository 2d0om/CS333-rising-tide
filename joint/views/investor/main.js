/* =====================================================================
   1. DATA PREPARATION  (the numbers themselves are in data.js; month 0 = Jan 2015, month 139 = Aug 2026)
   D.m[i] = [sales, mortgage registrations, off-plan sales]   D.r[i] = policy rate (%)
   ===================================================================== */
// D (the data) is defined in data.js, which is loaded before this file.
const URL_='https://raw.githubusercontent.com/sharios/CS333/main/2026-27/Part%202/transactions.csv';
const N=D.m.length;
const ix=(year,month)=>(year-2015)*12+month-1;          // (2022,3) -> month index
const monthDate=i=>new Date(2015+Math.floor(i/12),i%12,1);
const fmt=d3.timeFormat('%b %Y');

// one object per month
const P=D.m.map((a,i)=>({i, s:a[0], mo:a[1], op:a[2], r:D.r[i]}));

// 3-month centred average of a field (smooths random month-to-month noise)
function smooth(field,i){
  const a=Math.max(0,i-1), b=Math.min(N-1,i+1);
  let total=0;
  for(let j=a;j<=b;j++) total+=P[j][field];
  return total/(b-a+1);
}
P.forEach(p=>{
  p.S=smooth('s',p.i);              // smoothed sales
  p.M=smooth('mo',p.i);             // smoothed mortgage registrations
  p.q=p.M/p.S;                      // mortgage registrations per sale (smoothed)
});

// market phases (colour). Same five phases as before; hues kept, toned to the Rising Tide palette for the joint page.
const PH=[
 ['Pre-COVID','Jan 2015 – Feb 2020',0,ix(2020,2),'#8795ad'],
 ['Near-zero rates','Mar 2020 – Feb 2022',ix(2020,3),ix(2022,2),'#2f6db0'],
 ['Rate hikes','Mar 2022 – Jul 2023',ix(2022,3),ix(2023,7),'#d1495b'],
 ['Peak plateau','Aug 2023 – Aug 2024',ix(2023,8),ix(2024,8),'#4a2c7a'],
 ['Easing, then hold','Sep 2024 – Aug 2026',ix(2024,9),N-1,'#4bab78']];
const phaseOf=i=>PH.find(f=>i>=f[2]&&i<=f[3]);


/* =====================================================================
   2. STATE + SCALES
   ===================================================================== */
let win=[0,N-1];          // selected window (month indexes), set by the brush
let head=N-1;             // last month drawn (playback moves this)
let focus=null;           // month under the pointer / playhead (null = none)
let playing=false, timer=null, speed=1;
let hovered=null;         // nearest month to the pointer (used by click-to-jump)
let exact=false, zoom=true;   // display toggles

const L=70,R=975,mT=22,mB=390;                 // detail chart box
const sT=34,sB=110;                            // overview strip box
const x=d3.scaleLinear([0,6],[L,R]);           // rate -> pixels (domain updated in render)
const y=d3.scaleLinear([0,1],[mB,mT]);         // sales -> pixels (domain updated in render)
const t=d3.scaleLinear([0,N-1],[L,R]);         // month index -> pixels (overview)
const widthOf=d3.scaleLinear([.15,.4],[1.5,8]).clamp(true);   // mortgage ratio -> line width

const Y=p=>exact? p.s : p.S;                            // sales value used for y
const Q=p=>exact? p.mo/p.s : p.q;                       // mortgage ratio used for width / notes
const colourOf=p=>phaseOf(p.i)[4];                      // colour = market phase

/* =====================================================================
   3. THE DETAIL CHART (connected scatterplot)
   ===================================================================== */
const svg=d3.select('#v');
svg.append('defs').html('<marker id="ar" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M0,0L10,5L0,10z" fill="#8c93a8"/></marker>');

const axisX=d3.axisBottom(x).ticks(8).tickFormat(d=>d+'%').tickSize(-(mB-mT));
const axisY=d3.axisLeft(y).ticks(7).tickSize(-(R-L));
const gx=svg.append('g').attr('class','ax').attr('transform',`translate(0,${mB})`);
const gy=svg.append('g').attr('class','ax').attr('transform',`translate(${L},0)`);
svg.append('text').attr('x',(L+R)/2).attr('y',mB+36).attr('text-anchor','middle').text('CBUAE policy rate (%)  →');
svg.append('text').attr('transform',`translate(16,${(mT+mB)/2}) rotate(-90)`).attr('text-anchor','middle').text('Sales per month (10% sample)  →');

// the "textbook" arrow: faint by default, darker when the pointer is on it
const AX1=L+30, AY1=mT+70, AX2=R-40, AY2=mB-40;
const ref=svg.append('g').attr('pointer-events','none');           
const arrowLine=ref.append('line').attr('x1',AX1).attr('y1',AY1).attr('x2',AX2).attr('y2',AY2)
   .attr('stroke','#8c93a8').attr('stroke-width',3).attr('stroke-dasharray','10 8').attr('opacity',.15).attr('marker-end','url(#ar)');
const arrowText=ref.append('text').attr('class','hl').attr('x',L+34).attr('y',mT+58).attr('font-style','italic').attr('opacity',.4)
   .text('Textbook expectation (schematic): higher rates → fewer sales');
function highlightArrow(on){
  arrowLine.transition().duration(150).attr('opacity',on? .5 : .15);
  arrowText.transition().duration(150).attr('opacity',on? 1 : .4);
}

// layers (drawn in this order)
const real=svg.append('g');                                   // everything that belongs to the real data
const ghost=real.append('path').attr('fill','none').attr('stroke','var(--ink)').attr('opacity',.2);
const segs=real.append('g').attr('stroke-linecap','round');   // line segments
const dots=real.append('g');                                  // month dots
const labs=real.append('g');                                  // year labels

// flashlight lines (hover / playhead)
const fl=svg.append('g').attr('opacity',0).attr('pointer-events','none');
const flX=fl.append('line'), flY=fl.append('line'), flC=fl.append('circle').attr('r',6).attr('fill','none').attr('stroke','var(--acc)').attr('stroke-width',2.5);
[flX,flY].forEach(l=>l.attr('stroke','var(--acc)').attr('stroke-dasharray','5 4').attr('stroke-width',1.3));

// readout, top-right of the chart
const rd1=svg.append('text').attr('x',R).attr('y',mT+16).attr('text-anchor','end').style('font-size','14px').style('font-weight',700).attr('fill','var(--ink)');
const rd2=svg.append('text').attr('x',R).attr('y',mT+33).attr('text-anchor','end');

// Redraw the chart for the current window / head / toggles.
function render(){
  // axes: zoom to the window, or keep the full range
  const [a,b]=zoom? win : [0,N-1];
  const inView=P.slice(a,b+1);
  x.domain([0,d3.max(inView,p=>p.r)*1.08]).nice();
  y.domain([0,d3.max(inView,Y)*1.1]).nice();
  gx.call(axisX); gy.call(axisY);

  // months to draw: inside the window and not later than the playhead
  const vis=P.filter(p=>p.i>=win[0] && p.i<=win[1] && p.i<=head);
  const line=d3.line().x(p=>x(p.r)).y(p=>y(Y(p)));
  ghost.attr('d', zoom? null : line(P.filter(p=>p.i<=head)));   // faint full path when axes are fixed

  segs.selectAll('line').data(vis.slice(1),p=>p.i).join('line')
    .attr('x1',p=>x(P[p.i-1].r)).attr('y1',p=>y(Y(P[p.i-1])))
    .attr('x2',p=>x(p.r)).attr('y2',p=>y(Y(p)))
    .attr('stroke-width',p=>widthOf((Q(p)+Q(P[p.i-1]))/2))
    .attr('stroke',colourOf).attr('opacity',.9);

  dots.selectAll('circle').data(vis,p=>p.i).join('circle')
    .attr('r',2.4).attr('cx',p=>x(p.r)).attr('cy',p=>y(Y(p))).attr('fill',colourOf);

  labs.selectAll('text').data(vis.filter(p=>p.i%12==0||p.i==win[0]),p=>p.i).join('text')
    .attr('class','hl').attr('x',p=>x(p.r)+6).attr('y',p=>y(Y(p))+14)
    .attr('fill','var(--ink)').style('font-size','11px').style('font-weight',600)
    .text(p=>p.i%12==0? 2015+p.i/12 : fmt(monthDate(p.i)));

  updatePanels();          // always refresh dial, notes, tape, readouts (no stale values)
}


/* =====================================================================
   4. THE GOVERNOR'S DESK: dial, sheet of 100 notes, ticker tape
   ===================================================================== */
// --- dial: needle angle runs from -90° (0%) to +90° (6%)
const dial=d3.select('#dial'), CX=110, CY=112;
const angle=rate=>-90+Math.max(0,Math.min(6,rate))/6*180;
d3.range(0,6.01,.5).forEach(v=>{
  const a=(angle(v)-90)*Math.PI/180, major=(v%1==0), r1=major?74:80, r2=88;
  dial.append('line').attr('x1',CX+r1*Math.cos(a)).attr('y1',CY+r1*Math.sin(a)).attr('x2',CX+r2*Math.cos(a)).attr('y2',CY+r2*Math.sin(a))
      .attr('stroke','var(--mut)').attr('stroke-width',major?2:1);
  if(major) dial.append('text').attr('x',CX+101*Math.cos(a)).attr('y',CY+101*Math.sin(a)+4).attr('text-anchor','middle').style('font-size','10px').text(v+'%');
});
dial.append('path').attr('transform',`translate(${CX},${CY})`).attr('fill','var(--grid)')
    .attr('d',d3.arc()({innerRadius:90,outerRadius:92,startAngle:-Math.PI/2,endAngle:Math.PI/2}));
const pulse=dial.append('circle').attr('cx',CX).attr('cy',CY).attr('r',8).attr('fill','none').attr('stroke','var(--acc)').attr('stroke-width',2).attr('opacity',0);
const needle=dial.append('g').attr('transform',`translate(${CX},${CY})`).append('g').attr('transform','rotate(-90)');
needle.append('line').attr('y1',12).attr('y2',-80).attr('stroke','var(--c1)').attr('stroke-width',3.5).attr('stroke-linecap','round');
dial.append('circle').attr('cx',CX).attr('cy',CY).attr('r',6).attr('fill','var(--ink)');
const dialTxt=dial.append('text').attr('x',CX).attr('y',150).attr('text-anchor','middle').attr('fill','var(--ink)').style('font-size','20px').style('font-weight',700);
let lastRate=null;
function moveDial(rate,instant){
  needle.interrupt();
  if(instant) needle.attr('transform',`rotate(${angle(rate)})`);
  else needle.transition().duration(700).ease(d3.easeBackOut.overshoot(2.2)).attr('transform',`rotate(${angle(rate)})`);
  dialTxt.text(rate.toFixed(2)+'%');
  if(lastRate!==null && Math.abs(rate-lastRate)>0.001 && !instant)          // a "click" when the rate changes
    pulse.attr('r',8).attr('opacity',.9).transition().duration(600).attr('r',44).attr('opacity',0);
  lastRate=rate;
}
moveDial(0,true);

// --- sheet of 100 notes: coloured = has a matching mortgage registration
const notes=d3.select('#notes');
notes.selectAll('rect').data(d3.range(100)).join('rect')
  .attr('x',k=>(k%10)*22+2).attr('y',k=>(9-Math.floor(k/10))*13).attr('width',18).attr('height',10).attr('rx',2)
  .attr('stroke','var(--mut)').attr('stroke-width',1);
function drawNotes(n,label){
  notes.selectAll('rect').attr('fill',k=>k<n? 'var(--c2)' : 'none').attr('opacity',k=>k<n? 1 : .45);
  d3.select('#notesTxt').html(`<b style="color:var(--ink)">${n} of every 100 sales</b> had a matching mortgage registration (${label}). The other ${100-n} are not necessarily cash.`);
}

// --- ticker tape: last three months in focus
const tape=d3.select('#tape');
let tapeI=-1;
function drawTape(p){
  if(p.i===tapeI) return;                      // only redraw when the month changes
  tapeI=p.i;
  const arrow=d=> d>0? '<span class="up">▲</span>' : d<0? '<span class="dn">▼</span>' : '<span class="fl">▬</span>';
  const items=d3.range(Math.max(0,p.i-2),p.i+1).map(i=>{
    const q=P[i], before=P[Math.max(0,i-1)];
    return `<span class="${i===p.i?'new':''}"><b>${fmt(monthDate(i)).toUpperCase()}</b> RATE ${q.r.toFixed(2)}% ${arrow(q.r-before.r)} SALES ${q.s} ${arrow(q.s-before.s)}</span>`;
  });
  tape.html('<span class="fl">TAPE</span>'+items.join(''));
}

/* =====================================================================
   5. OVERVIEW (100% stacked area) + BRUSH
   ===================================================================== */
const ov=d3.select('#ov');
const stackData=P.map(p=>({i:p.i, a:Math.min(1,p.q), b:1-Math.min(1,p.q)}));
const stacked=d3.stack().keys(['a','b'])(stackData);
const sy=d3.scaleLinear([0,1],[sB,sT]);
const bandColour=['var(--c2)','#8795ad'], bandOpacity=[.9,.4];
ov.append('g').selectAll('path').data(stacked).join('path')
  .attr('fill',(_,k)=>bandColour[k]).attr('opacity',(_,k)=>bandOpacity[k])
  .attr('d',d3.area().x(d=>t(d.data.i)).y0(d=>sy(d[0])).y1(d=>sy(d[1])).curve(d3.curveMonotoneX));
ov.append('g').attr('class','ax').attr('transform',`translate(${L},0)`).call(d3.axisLeft(sy).tickValues([0,.5,1]).tickFormat(d3.format('.0%')).tickSize(3));
[['Mortgage registrations',0,1],['No matching mortgage registration',190,.6]].forEach((a,k)=>{
  ov.append('rect').attr('x',L+a[1]).attr('y',8).attr('width',10).attr('height',10).attr('fill',bandColour[k]).attr('opacity',a[2]);
  ov.append('text').attr('x',L+a[1]+15).attr('y',17).text(a[0]);
});
const ovCorner=ov.append('text').attr('x',R).attr('y',17).attr('text-anchor','end').attr('fill','var(--ink)').style('font-weight',700);
PH.forEach(f=>ov.append('rect').attr('x',t(f[2])).attr('width',t(f[3])-t(f[2])+(R-L)/(N-1)).attr('y',sB+3).attr('height',6).attr('fill',f[4]));
ov.append('g').attr('class','ax').attr('transform',`translate(0,${sB+9})`).call(d3.axisBottom(t).tickValues(d3.range(0,N,12)).tickFormat(i=>2015+i/12).tickSize(3));
const ovMark=ov.append('line').attr('y1',sT).attr('y2',sB).attr('stroke','var(--ink)').attr('stroke-width',2).attr('opacity',0).attr('pointer-events','none');

let channel=null; try{ channel=new BroadcastChannel('rising-tide'); }catch(e){}
const brush=d3.brushX().extent([[L,sT],[R,sB]]).on('brush end',event=>{
  if(!event.selection) return;
  win=[Math.round(t.invert(event.selection[0])), Math.round(t.invert(event.selection[1]))];
  if(win[1]<=win[0]) win[1]=win[0]+1;
  if(!playing){ focus=null; head=N-1; }        // a new window shows the whole window and its overall value
  render();
  if(event.type=='end' && event.sourceEvent){  // the person (not code) moved it
    channel && channel.postMessage({from:win[0], to:win[1]});
    const snapped=[t(win[0]),t(win[1])];       // snap to whole months with a springy ease
    if(Math.abs(snapped[0]-event.selection[0])>.5 || Math.abs(snapped[1]-event.selection[1])>.5)
      brushG.transition().duration(650).ease(d3.easeBackOut.overshoot(1.8)).call(brush.move,snapped);
  }
});
const brushG=ov.append('g').call(brush);
const setWindow=(a,b,animate)=>{
  brushG.interrupt();
  if(animate) brushG.transition().duration(1000).ease(d3.easeBackOut.overshoot(1.5)).call(brush.move,[t(a),t(b)]);
  else brushG.call(brush.move,[t(a),t(b)]);
};
if(channel) channel.onmessage=e=>setWindow(e.data.from,e.data.to,false);

// playhead: drag the ▼ to jump to any month of the playback (drawn after the brush so it sits on top)
const playhead=ov.append('g').attr('cursor','ew-resize');
playhead.append('line').attr('y1',sT).attr('y2',sB).attr('stroke','var(--acc)').attr('stroke-width',2).attr('pointer-events','none');
playhead.append('path').attr('d','M-7,-12 L7,-12 L0,0 Z').attr('transform',`translate(0,${sT})`).attr('fill','var(--acc)');
playhead.append('rect').attr('x',-12).attr('y',sT-16).attr('width',24).attr('height',20).attr('fill','transparent');   // bigger grab area
playhead.call(d3.drag().on('start drag',event=>scrub(Math.round(t.invert(event.x)))));

/* =====================================================================
   6. ONE FUNCTION KEEPS EVERY PANEL IN SYNC
   ===================================================================== */
const windowRatio=()=>{ const W=P.slice(win[0],win[1]+1); return d3.sum(W,p=>p.mo)/d3.sum(W,p=>p.s); };
const current=()=> focus || P[Math.max(win[0],Math.min(head,win[1]))];   // the month the panels describe

function updatePanels(){
  playhead.attr('transform',`translate(${t(Math.max(win[0],Math.min(head,win[1])))},0)`);   // playhead follows playback
  const p=current();
  rd1.text(`${fmt(monthDate(p.i))} · policy rate ${p.r.toFixed(2)}%`);
  rd2.text(`${Math.round(Y(p))} sales in the sample · ${phaseOf(p.i)[0]}`);
  // flashlight only while a month is in focus
  if(focus){
    const px=x(p.r), py=y(Y(p));
    fl.attr('opacity',1);
    flX.attr('x1',px).attr('x2',px).attr('y1',py).attr('y2',mB);
    flY.attr('x1',L).attr('x2',px).attr('y1',py).attr('y2',py);
    flC.attr('cx',px).attr('cy',py);
    ovMark.attr('opacity',1).attr('x1',t(p.i)).attr('x2',t(p.i));
  } else { fl.attr('opacity',0); ovMark.attr('opacity',0); }
  // overview corner + notes: the focused month's ratio, otherwise the whole window's
  const ratio=focus? Q(focus) : windowRatio();
  const n=Math.round(100*ratio), label=focus? fmt(monthDate(focus.i)) : 'selected window';
  ovCorner.text(focus? `${label}: ${n} mortgage registrations per 100 sales` : `Window: ${n} mortgage registrations per 100 sales`);
  drawNotes(n,label);
  moveDialIfNeeded(p.r);
  drawTape(p);
}
let dialRate=null;
function moveDialIfNeeded(rate){ if(rate!==dialRate){ dialRate=rate; moveDial(rate,false); } }

/* =====================================================================
   7. INTERACTION: hover, jump to a month, playback, buttons
   ===================================================================== */
const hoverRect=svg.append('rect').attr('x',L).attr('y',mT).attr('width',R-L).attr('height',mB-mT).attr('fill','transparent');
hoverRect.on('pointermove',event=>{
  if(playing) return;
  const [mx,my]=d3.pointer(event);
  let best=null, bestDist=Infinity;
  for(const p of P){                           // nearest visible month to the pointer
    if(p.i>head||p.i<win[0]||p.i>win[1]) continue;
    const d=(x(p.r)-mx)**2+(y(Y(p))-my)**2;
    if(d<bestDist){ bestDist=d; best=p; }
  }
  if(best){ focus=best; hovered=best; updatePanels(); }
}).on('click',()=>{ if(hovered) scrub(hovered.i); })          // click a point = jump there
  .on('pointerleave',()=>{ hovered=null; if(!playing){ focus=null; updatePanels(); } });

// an invisible, wider copy of the arrow sits above the hover rectangle so the pointer can "find" it
const arrowHit=svg.append('line').attr('x1',AX1).attr('y1',AY1).attr('x2',AX2).attr('y2',AY2)
  .attr('stroke','transparent').attr('stroke-width',22).attr('pointer-events','stroke')
  .on('pointerenter',()=>highlightArrow(true)).on('pointerleave',()=>highlightArrow(false));
arrowHit.append('title').text('What simple theory predicts: higher borrowing costs → fewer buyers');


const button=(parent,label,onclick)=>d3.select('#'+parent).append('button').text(label).on('click',onclick);
const playBtn=button('g1','▶ Play',()=>playing? pause() : play());
button('g1','↺ Reset',reset);
// speed: 1× = 400 ms per month; − and + step through 0.25× … 4×
const SPEEDS=[.25,.5,1,2,4]; let speedIdx=2;
button('g1','−',()=>changeSpeed(-1)).attr('title','Slower');
const speedLabel=d3.select('#g1').append('span').style('font-size','11.5px').style('min-width','34px').style('text-align','center').style('align-self','center').text('1×');
button('g1','+',()=>changeSpeed(1)).attr('title','Faster');
function changeSpeed(step){
  speedIdx=Math.max(0,Math.min(SPEEDS.length-1,speedIdx+step));
  speed=SPEEDS[speedIdx]; speedLabel.text(speed+'×');
  if(playing) startTimer();
}

// the team's four periods (same labels and month ranges as the other seats)
[['2015–17',0,35],['2018–20',36,71],['2021–23',72,107],['2024–26',108,N-1],['All',0,N-1]]
  .forEach(a=>button('g2',a[0],()=>setWindow(a[1],a[2],true)));

const axesBtn=button('g3','Axes: zoom',()=>{ zoom=!zoom; axesBtn.text(zoom?'Axes: zoom':'Axes: fixed'); render(); });
const valuesBtn=button('g3','Values: smoothed',()=>{ exact=!exact; valuesBtn.text(exact?'Values: exact':'Values: smoothed'); render(); });

const badge=d3.select('#badge');

// jump to a month: used by clicking a point and by dragging the playhead
function scrub(m){
  pause();
  m=Math.max(win[0],Math.min(win[1],m));
  head= m>=win[1]? N-1 : m;                    // right edge of the window = show everything
  focus=P[m];
  render();
}

// playback: each tick reveals one more month
function tick(){
  head++;
  if(head>=win[1]){ head=win[1]; pause(); }
  focus=P[head];
  render();
}
function startTimer(){ timer&&timer.stop(); timer=d3.interval(tick,400/speed); }
function play(){
  if(head>=win[1]||head<win[0]) head=win[0];   // start from the beginning of the window
  playing=true; playBtn.text('❚❚ Pause').classed('on',true);
  startTimer();
}
function pause(){ timer&&timer.stop(); playing=false; playBtn.text('▶ Play').classed('on',false); }
function reset(){
  pause(); focus=null; head=N-1; dialRate=null;
  setWindow(0,N-1,false);
  render();
}

/* =====================================================================
   8. LEGEND
   ===================================================================== */
function legend(){
  d3.select('#leg').html(`
   <div class="it"><b>Colour = market phase</b>${
     PH.map(f=>`<div class="ph"><i style="background:${f[4]}"></i><span>${f[0]} <small>${f[1].replace('Jan 2015','2015')}</small></span></div>`).join('')}</div>
   <div class="it"><b>Line width = mortgage registrations per 100 sales</b><div class="wl">${
     [[.15,'15'],[.25,'25'],[.4,'40']].map(a=>`<span><i style="height:${widthOf(a[0])}px"></i>${a[1]}</span>`).join('')}</div></div>
   <div class="it"><span style="display:inline-block;width:16px;border-top:2px dashed #8c93a8;vertical-align:middle"></span> textbook expectation (hover the arrow)</div>`);
}

/* =====================================================================
   9. START UP
   ===================================================================== */
legend();
setWindow(0,N-1,false);       // also triggers the first render()
render();

// background check against the live CSV (works when the page is hosted where fetch is allowed)
const abort=new AbortController(), timeout=setTimeout(()=>abort.abort(),20000), snapshotSales=P.reduce((a,p)=>a+p.s,0);
d3.csv(URL_,{signal:abort.signal},r=>({k:ix(+r.instance_date.slice(0,4),+r.instance_date.slice(5,7)),g:r.trans_group_en,w:+r.actual_worth}))
  .then(rows=>{ clearTimeout(timeout); let s=0; for(const r of rows) if(r.k>=0&&r.k<N&&r.w>=10000&&r.g==='Sales') s++;
    badge.text(s===snapshotSales? '✓ snapshot verified against live CSV' : 'live CSV differs ('+s+' vs '+snapshotSales+')'); })
  .catch(()=>badge.text('embedded snapshot (live CSV not reachable from this host)'));
