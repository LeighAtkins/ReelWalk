import { expect, test } from '@playwright/test';
import { clipSchema, makeHeadLock, rampPreset } from '../../packages/core/src';
import { motionTransform } from '../../packages/render/src/reel/presentation';
import { drawClipFrame, type DrawContext } from '../../apps/web/components/editor/frame-draw';

// No server or login: exercise the real CSS compositor and the canvas frame-service drawing path.
test.use({ storageState: { cookies: [], origins: [] }, deviceScaleFactor: 1 });

for (const source of [{width:1080,height:1920},{width:1920,height:1080}]) {
  test(`head lock CSS/canvas pixels match for ${source.width}×${source.height}, trims, speed and ramps`, async ({page})=>{
    const samples=Array.from({length:25},(_,i)=>({ms:i*50,x0:.45+.015*Math.sin(i),x1:.55+.015*Math.sin(i),y0:.32+.025*Math.cos(i),y1:.48+.025*Math.cos(i)}));
    const headLock=makeHeadLock(samples,source,0,1200);
    for(const ramp of [null,rampPreset('into-cut')]) for(const seconds of [0,.15,.35]){
      const clip=clipSchema.parse({id:'a',assetId:'v',kind:'VIDEO',sourceStartMs:100,sourceEndMs:1100,speed:2,zoom:1.1,headLock,ramp});
      const moment={progress:seconds/.5,seconds};
      type Op={name:string;args:number[]};
      const ops:Op[]=[];
      const ctx={filter:'none',fillStyle:'#000',setTransform:(...args:number[])=>ops.push({name:'setTransform',args}),fillRect:(...args:number[])=>ops.push({name:'fillRect',args}),save:()=>ops.push({name:'save',args:[]}),restore:()=>ops.push({name:'restore',args:[]}),drawImage:(_:unknown,...args:number[])=>ops.push({name:'drawImage',args})} as unknown as DrawContext;
      drawClipFrame(ctx,{} as CanvasImageSource,source,clip,moment,180,320,{kind:'view',grade:'',canFilter:false});
      await page.setContent('<style>body{margin:0}#stage{width:180px;height:320px;overflow:hidden;background:black}img{width:100%;height:100%;object-fit:cover;transform-origin:center}</style><div id="stage"><img></div>');
      const canvasPixels=await page.evaluate(async ({source,ops,transform})=>{
        const texture=document.createElement('canvas');texture.width=source.width;texture.height=source.height;
        const paint=texture.getContext('2d')!;
        for(let y=0;y<source.height;y+=24)for(let x=0;x<source.width;x+=24){paint.fillStyle=`rgb(${40+(x*7+y*3)%190},${30+(x*3+y*5)%200},${40+(x*11+y*7)%190})`;paint.fillRect(x,y,24,24);}
        const img=document.querySelector('img')!;img.src=texture.toDataURL();img.style.transform=transform!;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;
        const context=canvas.getContext('2d')!;
        for(const op of ops){
          const args=op.args;
          if(op.name==='drawImage')context.drawImage(texture,...args as [number,number,number,number,number,number,number,number]);
          else if(op.name==='setTransform')context.setTransform(...args as [number,number,number,number,number,number]);
          else if(op.name==='fillRect')context.fillRect(...args as [number,number,number,number]);
          else if(op.name==='save')context.save();else context.restore();
        }
        return Array.from(context.getImageData(0,0,180,320).data);
      },{source,ops,transform:motionTransform(clip,moment.progress,seconds)});
      const png=await page.locator('#stage').screenshot();
      const difference=await page.evaluate(async ({png,expected})=>{
        const img=new Image();img.src=`data:image/png;base64,${png}`;await img.decode();
        const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;const ctx=canvas.getContext('2d')!;ctx.drawImage(img,0,0);
        const actual=ctx.getImageData(0,0,180,320).data;
        let same=0,shifted=0,count=0;
        // Patch means tolerate resampling differences while detecting a displaced crop.
        for(let y=8;y<312;y+=8)for(let x=8;x<164;x+=8)for(let c=0;c<3;c++){
          let a=0,b=0,wrong=0;
          for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){
            const i=((y+dy)*180+x+dx)*4+c;a+=actual[i];b+=expected[i];wrong+=expected[i+8*4];
          }
          same+=Math.abs(a-b)/25;shifted+=Math.abs(a-wrong)/25;count++;
        }
        return {same:same/count,shifted:shifted/count};
      },{png:png.toString('base64'),expected:canvasPixels});
      expect(difference.same,`seconds=${seconds}, ramp=${ramp?.preset}`).toBeLessThan(5);
      expect(difference.shifted).toBeGreaterThan(difference.same+8);
    }
  });
}
