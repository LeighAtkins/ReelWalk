import { z } from "zod";

/** Authored mesh placement. No reconstructed surfaces, tracking or occlusion. */
export const physicalTextSchema = z.object({
  depth: z.number().min(.06).max(.3).default(.14),
  tilt: z.number().min(-20).max(20).default(-12),
  light: z.enum(["left", "right", "above"]).default("left"),
  motion: z.boolean().default(true),
  shadow: z.number().min(0).max(.6).default(.3),
});
export type PhysicalText = z.infer<typeof physicalTextSchema>;
/** All 95 pinned ASCII meshes use at most 12,888 vertices/glyph at the
 * renderer's six curve segments/two bevel segments. Tests pin that contract. */
export const MAX_PHYSICAL_TEXT_VERTICES = 80 * 12_888;
export const MIN_PHYSICAL_TEXT_FONT_PX = 32;
export function physicalTextProblem(text: string, size = 1): string | null {
  if (!text.trim()) return "Physical 3D needs visible letters.";
  if (text.length > 80) return "Physical 3D supports up to 80 characters. Shorten the title or choose flat text.";
  if (!/^[\x20-\x7e\n\r]+$/.test(text)) return "Physical 3D supports English letters, numbers and ASCII punctuation. Choose flat text for other characters.";
  if (text.replace(/\r\n|\r/g, "\n").split("\n").length > 3) return "Physical 3D supports up to three lines. Shorten the title or choose flat text.";
  const lines=text.replace(/\r\n|\r/g, "\n").split("\n");
  const box=physicalTextBox(size);
  // Pinned font: max advance108.8 + positive kerning4.4 <114 at size100.
  // Ink overhang + bevel <12; complete glyph height <108. Three-line
  // baseline spacing is125. These bounds deliberately include narrow glyphs
  // too, so no accepted title can silently shrink below readable size.
  const fit=Math.min((box.width-100)/(114*Math.max(...lines.map(line=>line.length))+12), (box.height-100)/(108+125*(lines.length-1)), 1.4*size);
  if (fit*100 < MIN_PHYSICAL_TEXT_FONT_PX) return "Physical 3D needs shorter lines at this size. Add line breaks (up to three lines), increase Size, or choose flat text.";
  return null;
}
/** Frame-driven motion has no entrance/exit fade and holds until the shot cuts. */
export function physicalTextPose(config: PhysicalText, elapsedMs: number) {
  const t = config.motion ? Math.max(0, Math.min(1, elapsedMs / 2400)) : 1;
  const eased = t * t * (3 - 2 * t);
  return { rotateZ: config.motion ? (1 - eased) * 2 * Math.PI / 180 : 0, z: config.motion ? 4 + 5 * eased : 4, tilt: config.tilt * Math.PI / 180 };
}
/** Conservative frame-space footprint includes extrusion and bounded receiver. */
export function physicalTextBox(size: number) {
  return { width: Math.min(900, 760 * size), height: Math.min(330, 230 * size) };
}
/** Orthographic authored placement including the bounded receiver and the whole
 * moving volume. Shared by canvas rendering and editor selection/drag handles. */
export function physicalTextPlacement(size:number, config:PhysicalText, x:number, y:number, elapsedMs:number) {
  const box=physicalTextBox(size), pose=physicalTextPose(config,elapsedMs);
  const points:{x:number;y:number}[]=[];
  const project=(px:number,py:number,z:number,rotate:boolean)=>{
    const rx=rotate ? px*Math.cos(pose.rotateZ)-py*Math.sin(pose.rotateZ) : px;
    const ry=rotate ? px*Math.sin(pose.rotateZ)+py*Math.cos(pose.rotateZ) : py;
    points.push({x:rx*Math.cos(pose.tilt)+z*Math.sin(pose.tilt),y:ry});
  };
  for(const sx of [-1,1]) for(const sy of [-1,1]) {
    project(sx*box.width/2,sy*box.height/2,-28,false);
    for(const z of [pose.z,100+pose.z]) project(sx*(box.width-80)/2,sy*(box.height-80)/2,z,true);
  }
  const minX=Math.min(...points.map(p=>p.x)),maxX=Math.max(...points.map(p=>p.x));
  const minY=Math.min(...points.map(p=>p.y)),maxY=Math.max(...points.map(p=>p.y));
  const px=Math.max(-540-minX,Math.min(540-maxX,(x-.5)*1080));
  const py=Math.max(-700-minY,Math.min(480-maxY,(.5-y)*1920));
  return {x:px,y:py,pose,bounds:{left:540+px+minX,right:540+px+maxX,top:960-py-maxY,bottom:960-py-minY}};
}
