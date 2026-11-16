import { BufferGeometry, Vector3 } from "three";
import { TextGeometry } from "three/addons/geometries/TextGeometry.js";
import { FontLoader } from "three/addons/loaders/FontLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { physicalTextProblem, physicalTextBox, MAX_PHYSICAL_TEXT_VERTICES, type PhysicalText } from "@reelwalk/core";
import data from "./assets/instrument-sans-500.typeface.json";
const font = new FontLoader().parse(data);
export function createPhysicalTextGeometry(text: string, size: number, config: PhysicalText): BufferGeometry {
  const problem = physicalTextProblem(text, size); if (problem) throw new Error(problem);
  const pieces: BufferGeometry[] = [], groups: {start:number;count:number;materialIndex:number}[] = [];
  let count = 0;
  try {
    for (const [row, line] of text.replace(/\r\n|\r/g, "\n").split("\n").entries()) {
      const rowPieces: BufferGeometry[] = []; let x = 0;
      for (let i = 0; i < line.length; i++) {
        const char = line[i], glyph = data.glyphs[char as keyof typeof data.glyphs];
        if (!glyph) throw new Error("Unsupported physical 3D character. Choose flat text.");
        if (glyph.o) {
          const geometry = new TextGeometry(char, {font, size:100, depth:100*config.depth, curveSegments:6, steps:1, bevelEnabled:true, bevelSize:1, bevelThickness:1, bevelSegments:2});
          pieces.push(geometry); rowPieces.push(geometry);
          geometry.translate(x, -row*125, 0);
          for (const group of geometry.groups) groups.push({start:group.start+count,count:group.count,materialIndex:group.materialIndex ?? 0});
          count += geometry.getAttribute("position").count;
          if (count > MAX_PHYSICAL_TEXT_VERTICES) throw new Error("Physical 3D title too complex. Shorten it or choose flat text.");
        }
        x += (glyph.ha + (data.kernings[(char+(line[i+1] ?? "")) as keyof typeof data.kernings] ?? 0))/10 + (char === " " ? config.depth*35 : 0);
      }
      for (const piece of rowPieces) piece.translate(-x/2,0,0);
    }
    if (!pieces.length) throw new Error("Physical 3D needs visible letters.");
    const merged = mergeGeometries(pieces, false);
    if (!merged) throw new Error("Physical 3D geometry could not be joined.");
    merged.clearGroups(); for (const group of groups) merged.addGroup(group.start,group.count,group.materialIndex);
    merged.computeBoundingBox(); const box = merged.boundingBox!, center = box.getCenter(new Vector3()), extent = box.getSize(new Vector3());
    const bounds = physicalTextBox(size), fit = Math.min((bounds.width-100)/extent.x,(bounds.height-100)/extent.y,1.4*size);
    merged.translate(-center.x,-center.y,-box.min.z); merged.scale(fit,fit,fit);
    merged.computeBoundingBox(); merged.computeBoundingSphere(); merged.userData.fontSize = 100 * fit; return merged;
  } finally { for (const piece of pieces) piece.dispose(); }
}
export { physicalTextPlacement } from "@reelwalk/core";
