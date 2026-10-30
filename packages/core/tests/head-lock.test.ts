import { describe, expect, it } from 'vitest';
import { makeHeadLock, headLockAt, headLockSchema, clipSchema, parseTimeline, applyCommand, clipPicture, sourceToComposition, clipSourceMsAt, trimClip, planPace, paceOrigin, clipsKey, rampPreset, splitClip, updateClip, type CameraClip, type FaceSample } from '../src';
const track: FaceSample[] = Array.from({length: 25}, (_, i) => {const y=.34+Math.sin(i*Math.PI/6)*.07,h=.12+i*.0005;return {ms:i*50,x0:.44,y0:y-h/2,x1:.56,y1:y+h/2};});
const lock=()=>makeHeadLock(track,{width:1080,height:1920},0,1200);
describe('head-locked camera',()=>{
 it('requires source timing when a camera clip carries a head lock',()=>{
  // @ts-expect-error A tracked camera cannot be evaluated without source timing.
  const missing: CameraClip = {motion:'none',headLock:lock()};
  expect(missing.headLock).toBeDefined();
 });
 it('refuses schema-valid locks whose height compensation would expose borders',()=>{
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:1200}],texts:[],music:null});
  const invalid={...lock(),zoom:1,referenceHeight:.05,keys:lock().keys.map(k=>({...k,height:.5}))};
  expect(headLockSchema.safeParse(invalid).success).toBe(true);
  const result=applyCommand(t,{type:'setHeadLock',clipId:'a',headLock:invalid},{generation:0});
  expect(result.rejected).toContain('unfilled borders');
  expect(result.timeline).toBe(t);
  const edge={...invalid,target:{x:0,y:.35},keys:invalid.keys.map(k=>({...k,x:0}))};
  expect(headLockSchema.safeParse(edge).success).toBe(true);
  expect(applyCommand(t,{type:'setHeadLock',clipId:'a',headLock:edge},{generation:0}).rejected).toContain('unfilled borders');
  expect(headLockSchema.safeParse({...lock(),zoom:3.001}).success).toBe(false);
  expect(headLockSchema.safeParse({...lock(),keys:lock().keys.map(k=>({...k,height:1e-10}))}).success).toBe(false);
 });
 it('stores keys rounded to four decimals and computes the reserve from those rounded values',()=>{
  const h=lock();
  for(const key of h.keys) for(const value of Object.values(key)) expect(value).toBe(Number(value.toFixed(4)));
 });
 it('clears locks for pacing, retiming, restored pace windows and distributed splits outside the track',()=>{
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:1200,volume:0,headLock:lock()}],texts:[],music:{assetId:'song',sourceStartMs:0,bpm:120,volume:.5}});
  const context={generation:0,sourceDurationsMs:{v:5000}};
  const plan=planPace(t,{energy:0,sourceDurationsMs:{v:5000},minTotalMs:3000})!;
  expect(plan.clips[0].sourceEndMs).toBeGreaterThan(1280);
  expect(plan.clips[0].headLock).toBeNull();
  expect(applyCommand(t,{type:'retime',shotMs:3000},context).timeline.clips[0].headLock).toBeNull();
  const restored=paceOrigin({...t,music:{...t.music!,pace:{base:[{id:'a',sourceStartMs:0,sourceEndMs:4000}],resultKey:clipsKey(t.clips),heroClipId:null}}});
  expect(restored.clips[0].headLock).toBeNull();
  expect(splitClip(t,'a',2,()=> 'b',5000).clips.every(c=>c.headLock===null)).toBe(true);
 });
 it('replaces head tracking when choosing a camera move or Motion sheet preset',()=>{
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:1200,headLock:lock()}],texts:[],music:null});
  for(const command of [{type:'setCamera',clipId:'a',camera:'push'}, {type:'applyMove',clipId:'a',move:'slow-push'}] as const){
   const result=applyCommand(t,command,{generation:0});
   expect(result.rejected).toBeUndefined();
   expect(result.timeline.clips[0].headLock).toBeNull();
   expect(result.timeline.clips[0].camera).toBeTruthy();
  }
  expect(updateClip(t,'a',{motion:'pan',camera:null}).clips[0].headLock).toBeNull();
  expect(updateClip(t,'a',{volume:.4}).clips[0].headLock).toEqual(lock());
 });
 it('evaluates head position at ramped source time, not linear playback time',()=>{
  for(const preset of ['slow-in','slow-out','into-cut','hold-snap','hit'] as const){
   const c=clipSchema.parse({id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:100,sourceEndMs:1100,speed:2,ramp:rampPreset(preset),headLock:lock()});
   for(const elapsed of [0,50,150,300,450]){
    const picture=clipPicture(c,{width:1080,height:1920},{progress:elapsed/500,seconds:elapsed/1000});
    const expected=headLockAt(c.headLock!,clipSourceMsAt(c,elapsed));
    expect(picture.scale).toBeCloseTo(expected.scale,10);
    expect(picture.shiftY).toBeCloseTo(expected.y/100,10);
   }
  }
 });
 it('holds the smoothed head position and apparent height, with filled edges between samples',()=>{
  const h=lock();
  for(let t=0;t<=1200;t+=5){
   const b=h.keys.find(k=>k.ms>=t)!;const a=h.keys[Math.max(0,h.keys.indexOf(b)-1)];const p=b.ms===a.ms?0:(t-a.ms)/(b.ms-a.ms);
   const x=a.x+(b.x-a.x)*p,y=a.y+(b.y-a.y)*p,height=a.height+(b.height-a.height)*p;
   const pose=headLockAt(h,t);
   expect(.5+pose.scale*(x-.5+pose.x/100)).toBeCloseTo(h.target.x,9);
   expect(.5+pose.scale*(y-.5+pose.y/100)).toBeCloseTo(h.target.y,9);
   expect(height*pose.scale).toBeCloseTo(h.referenceHeight*h.zoom,9);
   const left=.5+pose.scale*(-.5+pose.x/100),top=.5+pose.scale*(-.5+pose.y/100);
   expect(left).toBeLessThanOrEqual(0);expect(top).toBeLessThanOrEqual(0);
   expect(left+pose.scale).toBeGreaterThanOrEqual(1);expect(top+pose.scale).toBeGreaterThanOrEqual(1);
  }
 });
 it('uses source time through trims and speed in the shared picture geometry',()=>{
  const c=clipSchema.parse({id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:200,sourceEndMs:1000,speed:2,headLock:lock(),zoom:1.2});
  const pic=clipPicture(c,{width:1080,height:1920},{progress:.5,seconds:.2});
  const pose=headLockAt(c.headLock!,clipSourceMsAt(c,200),1.2);
  expect(pic.scale).toBeCloseTo(pose.scale);expect(pic.shiftY).toBeCloseTo(pose.y/100);
  const k=c.headLock!.keys.find(k=>k.ms===600)!;
  expect(sourceToComposition(pic,k.x*1080,k.y*1920)[1]).toBeCloseTo(c.headLock!.target.y);
 });
 it('refuses gaps, truncated tracks and impossible crops',()=>{
  expect(()=>makeHeadLock(track.slice(0,10),{width:1080,height:1920},0,1200)).toThrow('lost');
  expect(()=>makeHeadLock(track.filter((_,i)=>i<5||i>10),{width:1080,height:1920},0,1200)).toThrow('gaps');
  expect(()=>makeHeadLock(track.map(s=>({...s,x0:0,x1:.01})),{width:1080,height:1920},0,1200)).toThrow('crop');
  expect(headLockSchema.safeParse({...lock(),keys:[lock().keys[1],lock().keys[0]]}).success).toBe(false);
 });
 it('round-trips old timelines and applies/removes the effect as one command',()=>{
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:1200}],texts:[],music:null});
  expect(t.clips[0].headLock).toBeUndefined();
  const context={generation:0,sourceDurationsMs:{v:4000}};
  const applied=applyCommand(t,{type:'setHeadLock',clipId:'a',headLock:lock()},context);
  expect(applied.timeline.clips[0].headLock).toEqual(lock());
  const removed=applyCommand(applied.timeline,{type:'setHeadLock',clipId:'a',headLock:null},context);
  expect(removed.timeline.clips[0].headLock).toBeNull();
  expect(t.clips[0].headLock).toBeUndefined();
 });
 it('keeps a track for an inner trim and clears it when the source window is extended',()=>{
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:1200,headLock:lock()}],texts:[],music:null});
  expect(trimClip(t,'a',{sourceStartMs:100,sourceEndMs:1100},4000).clips[0].headLock).toEqual(lock());
  expect(trimClip(t,'a',{sourceStartMs:100,sourceEndMs:1600},4000).clips[0].headLock).toBeNull();
 });
 it('rejects a track for a photo or for a longer untracked source section',()=>{
  const context={generation:0,sourceDurationsMs:{v:4000}};
  const t=parseTimeline({version:1,clips:[{id:'a',assetId:'v',kind:'IMAGE',sourceStartMs:0,sourceEndMs:1200}],texts:[],music:null});
  expect(applyCommand(t,{type:'setHeadLock',clipId:'a',headLock:lock()},context).rejected).toContain('video');
  const longer={...t,clips:[{...t.clips[0],kind:'VIDEO' as const,sourceEndMs:2000}]};
  expect(applyCommand(longer,{type:'setHeadLock',clipId:'a',headLock:lock()},context).rejected).toContain('cover');
 });
});
