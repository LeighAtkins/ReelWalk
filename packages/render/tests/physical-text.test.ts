import { describe, expect, it } from "vitest";
import { Mesh, MeshBasicMaterial, Raycaster, Vector3, DoubleSide } from "three";
import { physicalTextSchema, physicalTextProblem, MAX_PHYSICAL_TEXT_VERTICES } from "@reelwalk/core";
import { createPhysicalTextGeometry, physicalTextPlacement } from "../src/reel/physical-text-geometry";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import fontData from "../src/reel/assets/instrument-sans-500.typeface.json";
const config=physicalTextSchema.parse({});
describe("actual physical title geometry",()=>{
 it("creates closed front/back and side groups with actual depth and an open O counter",()=>{
  const geometry=createPhysicalTextGeometry("O",1,config);
  try {
   expect(new Set(geometry.groups.map(g=>g.materialIndex))).toEqual(new Set([0,1]));
   const b=geometry.boundingBox!;expect(b.max.z-b.min.z).toBeGreaterThan(5);
   const material=new MeshBasicMaterial({side:DoubleSide});const mesh=new Mesh(geometry,material);mesh.updateMatrixWorld();
   const center=b.getCenter(new Vector3());expect(new Raycaster(new Vector3(center.x,center.y,300),new Vector3(0,0,-1)).intersectObject(mesh)).toHaveLength(0);material.dispose();
  } finally {geometry.dispose();}
 });
 it("refuses unsupported glyphs rather than rendering replacement glyphs",()=>{expect(()=>createPhysicalTextGeometry("\u00e9",1,config)).toThrow("ASCII");});
 it("fits long multiline geometry inside the bounded receiver",()=>{const geometry=createPhysicalTextGeometry("A beautiful place\nA beautiful life",2,config);try{const b=geometry.boundingBox!;expect(b.max.x-b.min.x).toBeLessThanOrEqual(800.01);expect(b.max.y-b.min.y).toBeLessThanOrEqual(230.01);}finally{geometry.dispose();}});
 it("pins every supported ASCII glyph and the proven worst-case vertex bound",()=>{
  const font=new FontLoader().parse(fontData);let worst=0;
  for(let code=32;code<=126;code++) {
   const char=String.fromCharCode(code),glyph=fontData.glyphs[char as keyof typeof fontData.glyphs];expect(glyph).toBeDefined();
   const geometry=new TextGeometry(char,{font,size:100,depth:14,curveSegments:6,steps:1,bevelEnabled:true,bevelSize:1,bevelThickness:1,bevelSegments:2});
   try {
    worst=Math.max(worst,geometry.getAttribute("position").count);
    expect(glyph.ha/10).toBeLessThanOrEqual(108.8);
    geometry.computeBoundingBox();const b=geometry.boundingBox!;
    if(!b.isEmpty()){expect(b.max.y-b.min.y).toBeLessThan(108);expect(b.min.x).toBeGreaterThan(-6);expect(b.max.x-glyph.ha/10).toBeLessThan(6);}
   } finally {geometry.dispose();}
  }
  expect(Math.max(...Object.values(fontData.kernings))/10).toBeLessThan(4.5);
  for(const [pair,kern] of Object.entries(fontData.kernings)) expect(fontData.glyphs[pair[0] as keyof typeof fontData.glyphs].ha+kern).toBeGreaterThanOrEqual(0);
  expect(worst).toBe(12888);expect(MAX_PHYSICAL_TEXT_VERTICES).toBe(80*worst);
 });
 it("renders admitted high-complexity copy beyond the old arbitrary cap and preserves minimum font size",()=>{
  const text=Array(3).fill("@".repeat(20)).join("\n");expect(physicalTextProblem(text,2)).toBeNull();
  const geometry=createPhysicalTextGeometry(text,2,config);try {
   expect(geometry.getAttribute("position").count).toBe(60*12888);
   expect(geometry.userData.fontSize).toBeGreaterThanOrEqual(32);
  } finally {geometry.dispose();}
  expect(()=>createPhysicalTextGeometry("i".repeat(80),2,config)).toThrow("shorter lines");
 });
 it("keeps the full moving volume and receiver within opening/UI margins at every frame",()=>{
  for(const tilt of [-20,20]) for(const size of [.6,1,2]) for(let frame=0;frame<240;frame++) {
   const b=physicalTextPlacement(size,{...config,tilt},0,0,frame*1000/30).bounds;
   expect(b.top).toBeGreaterThanOrEqual(480-1e-6);expect(b.left).toBeGreaterThanOrEqual(-1e-6);expect(b.right).toBeLessThanOrEqual(1080+1e-6);expect(b.bottom).toBeLessThanOrEqual(1660+1e-6);
  }
 });
});
