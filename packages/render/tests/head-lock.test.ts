import { describe, expect, it } from 'vitest';
import { clipPicture, clipSchema, makeHeadLock, type FaceSample } from '@reelwalk/core';
import { motionTransform } from '../src/reel/presentation';
const samples:FaceSample[]=Array.from({length:21},(_,i)=>({ms:i*50,x0:.4,y0:.25+.04*Math.sin(i),x1:.6,y1:.45+.04*Math.sin(i)}));
describe('head lock preview/export transform',()=>{
 it('keeps the CSS transform identical to frame-service geometry through a trimmed, sped-up clip',()=>{
  const headLock=makeHeadLock(samples,{width:1080,height:1920},0,1000);
  const clip=clipSchema.parse({id:'a',assetId:'video',kind:'VIDEO',sourceStartMs:100,sourceEndMs:900,speed:2,zoom:1.15,headLock});
  const picture=clipPicture(clip,{width:1080,height:1920},{progress:.5,seconds:.2});
  const css=motionTransform(clip,.5,.2)!;
  expect(css).toContain(`scale(${picture.scale})`);
  expect(css).toContain(`${picture.shiftX*100}%`);
  expect(css).toContain(`${picture.shiftY*100}%`);
 });
});
