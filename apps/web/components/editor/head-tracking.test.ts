import { afterEach, expect, it, vi } from 'vitest';
import { headTrackingLimits, trackHead } from './head-tracking';
import { luminance } from './frame-service';
import { headLockFrameKey } from './head-lock-cache';
import { clipSchema, type HeadLock } from '@reelwalk/core';

afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});

it('keeps phone luminance storage below 11 MB even at maximum accepted height',()=>{
  const limits=headTrackingLimits(true);
  expect(limits).toEqual({width:180,maxHeight:400,maxMs:6000});
  expect(limits.width*limits.maxHeight*Math.ceil(limits.maxMs*24/1000)).toBeLessThan(11_000_000);
  const canvas={width:2,height:1,getContext:()=>({getImageData:()=>({data:new Uint8ClampedArray([255,255,255,255,255,0,0,255])})})} as unknown as HTMLCanvasElement;
  const result=luminance(canvas,true);
  expect(result.data).toBeInstanceOf(Uint8Array);
  expect(result.data.byteLength).toBe(2);
  expect([...result.data]).toEqual([255,76]);
});

it.each([{userAgent:'iPhone',maxTouchPoints:1},{userAgent:'Macintosh',maxTouchPoints:5}])('rejects long phone and iPad tracks before opening a decoder: %j',async navigator=>{
  vi.stubGlobal('navigator',navigator);
  const clip=clipSchema.parse({id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:0,sourceEndMs:7000});
  await expect(trackHead('video.mp4',clip,{x0:.4,y0:.2,x1:.6,y1:.4},new AbortController().signal,()=>{})).rejects.toThrow('6 seconds');
});

it('hashes each immutable track once, including edits to its middle keys',()=>{
  const lock:HeadLock={version:1,target:{x:.5,y:.35},referenceHeight:.2,zoom:1.5,keys:[0,100,200].map(ms=>({ms,x:.5,y:.35,height:.2}))};
  const stringify=vi.spyOn(JSON,'stringify');
  const key=headLockFrameKey(lock);
  expect(key.length).toBeLessThanOrEqual(8);
  for(let i=0;i<100;i++)expect(headLockFrameKey(lock)).toBe(key);
  expect(stringify).toHaveBeenCalledTimes(1);
  const changed={...lock,keys:lock.keys.map((k,i)=>i===1?{...k,y:.4}:k)};
  expect(headLockFrameKey(changed)).not.toBe(key);
});
