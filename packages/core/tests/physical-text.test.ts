import { describe, expect, it } from "vitest";
import { physicalTextSchema, physicalTextProblem, physicalTextPose } from "../src/physical-text";
import { textSchema, timelineSchema } from "../src/timeline";
const base={id:"t",text:"A real home",startMs:0,endMs:8000,size:1,style:"plain"};
describe("physical titles",()=>{
 it("keeps old timelines sparse and opt in",()=>{expect(textSchema.parse(base)).not.toHaveProperty("physical3d");expect(textSchema.parse({...base,physical3d:{}}).physical3d).toEqual(physicalTextSchema.parse({}));});
 it("rejects unsupported glyphs and conflicting tracking instead of silently substituting",()=>{expect(physicalTextProblem("\u6b22\u8fce")).toContain("ASCII");expect(textSchema.safeParse({...base,text:"\u6b22\u8fce",physical3d:{}}).success).toBe(false);expect(textSchema.safeParse({...base,physical3d:{},behind:true}).success).toBe(false);expect(textSchema.safeParse({...base,physical3d:{},surface:[0,0,1,0,1,1,0,1]}).success).toBe(false);});
 it("holds physical pose after a short deterministic motion without disappearing",()=>{const config=physicalTextSchema.parse({});expect(physicalTextPose(config,0)).not.toEqual(physicalTextPose(config,2400));expect(physicalTextPose(config,2400)).toEqual(physicalTextPose(config,7999));expect(physicalTextPose({...config,motion:false},0)).toEqual(physicalTextPose({...config,motion:false},7999));});
 it("limits mesh canvases per reel while leaving legacy title counts unchanged",()=>{const texts=Array.from({length:5},(_,i)=>({...base,id:String(i),physical3d:{}}));expect(timelineSchema.safeParse({version:1,clips:[],texts,music:null}).success).toBe(false);expect(timelineSchema.safeParse({version:1,clips:[],texts:texts.map(text=>({...text,physical3d:undefined})),music:null}).success).toBe(true);});
 it("rejects unreadable narrow or long configurations before rendering with an actionable recovery",()=>{
  expect(physicalTextProblem("i".repeat(80),2)).toContain("shorter lines");
  expect(textSchema.safeParse({...base,text:"A sentence that fills eighty characters cannot stay readable on a single line!!!!",physical3d:{}}).success).toBe(false);
  expect(physicalTextProblem("A beautiful place\nA beautiful life",2)).toBeNull();
  expect(physicalTextProblem("Small type",.3)).toContain("increase Size");
 });
 it("bounds settings and text complexity",()=>{expect(physicalTextSchema.safeParse({depth:10}).success).toBe(false);expect(physicalTextProblem("A".repeat(81))).not.toBeNull();expect(physicalTextProblem("a\nb\nc\nd")).not.toBeNull();});
});
