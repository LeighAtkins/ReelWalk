import { describe, expect, it } from 'vitest';
import { makeHeadLock, headLockAt, headLockSchema, clipSchema, parseTimeline, applyCommand, clipPicture, sourceToComposition, clipSourceMsAt, trimClip, type FaceSample } from '../src';
const track: FaceSample[] = Array.from({length: 25}, (_, i) => {const y=.34+Math.sin(i*Math.PI/6)*.07,h=.12+i*.0005;return {ms:i*50,x0:.44,y0:y-h/2,x1:.56,y1:y+h/2};});
const lock=()=>makeHeadLock(track,{width:1080,height:1920},0,1200);
describe('head-locked camera',()=>{
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
