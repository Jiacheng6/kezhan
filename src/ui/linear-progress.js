const clamp=n=>Math.max(0,Math.min(1,n));
export function sampleProgress(plan,now){
  if(!plan)return 0;
  const elapsed=Math.max(0,now-plan.start);
  if(plan.catchupMs&&elapsed<plan.catchupMs)return plan.from+(plan.anchor-plan.from)*elapsed/plan.catchupMs;
  const t=Math.min(1,Math.max(0,(elapsed-plan.catchupMs)/Math.max(1,plan.travelMs)));
  return plan.anchor+(plan.target-plan.anchor)*t;
}
export function planProgress(previous,{key,measured=0,ceiling=measured,rate=0,running=false,complete=false},now){
  measured=clamp(Number(measured)||0);
  const same=previous?.key===key,from=same?sampleProgress(previous,now):measured;
  if(!running&&!complete)return {key,from,anchor:from,target:from,start:now,catchupMs:0,travelMs:0};
  const anchor=Math.max(from,measured),target=complete?1:Math.max(anchor,Math.min(.99,ceiling));
  const catchupMs=anchor>from?1200:0;
  return {key,from,anchor,target,start:now,catchupMs,travelMs:complete?450:rate>0?(target-anchor)/rate*1000:0};
}

const motions=new WeakMap(),active=new Set();let ticker;
function paintNumber(track,state,now){
  const value=sampleProgress(state.plan,now);
  track.setAttribute('aria-valuenow',(value*100).toFixed(1));
  state.options.onDisplay?.(value,state.options.estimated||value>(state.options.measured||0)+.0005);
}
export function animateProgress(track,options){
  let state=motions.get(track);
  const signature=JSON.stringify([options.key,options.measured,options.ceiling,options.rate,options.running,options.complete,options.reduced]);
  if(state?.signature===signature){state.options=options;paintNumber(track,state,performance.now());return;}
  const now=performance.now(),plan=planProgress(state?.options.complete&&options.running?null:state?.plan,options,now),fill=track.querySelector('.tp-fill');
  state?.animation?.cancel();fill.style.transition='none';
  // Respect reduced motion: measured values remain available without prediction.
  if(options.reduced){plan.from=plan.anchor=plan.target=options.measured||0;plan.catchupMs=plan.travelMs=0;}
  fill.style.transform=`scaleX(${plan.target})`;
  const duration=plan.catchupMs+plan.travelMs;
  let animation;
  if(duration>0){
    const frames=[{transform:`scaleX(${plan.from})`,offset:0}];
    if(plan.catchupMs&&plan.travelMs)frames.push({transform:`scaleX(${plan.anchor})`,offset:plan.catchupMs/duration});
    frames.push({transform:`scaleX(${plan.target})`,offset:1});
    animation=fill.animate(frames,{duration,easing:'linear',fill:'both'});
  }
  state={plan,signature,options,animation};motions.set(track,state);paintNumber(track,state,now);
  active.add(track);
  if(!ticker)ticker=setInterval(()=>{
    const time=performance.now();
    for(const node of active){const s=motions.get(node);if(!node.isConnected||!s){s?.animation?.cancel();active.delete(node);continue;}paintNumber(node,s,time);if(time>=s.plan.start+s.plan.catchupMs+s.plan.travelMs)active.delete(node);}
    if(!active.size){clearInterval(ticker);ticker=null;}
  },200);
}
