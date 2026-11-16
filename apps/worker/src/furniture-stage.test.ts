import sharp from "sharp";
import { expect, it } from "vitest";
import { compositeFurnitureStage } from "./furniture-stage";

it("restores every source pixel outside the selected area before JPEG encoding", async () => {
  const source = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#204060" } }).png().toBuffer();
  const generated = await sharp({ create: { width: 20, height: 20, channels: 3, background: "#ff0000" } }).png().toBuffer();
  const png = await compositeFurnitureStage(source, generated, { version: 1, style: "warm-minimal", instructions: "", region: { x: .25, y: .25, width: .5, height: .5 } }, 20, 20);
  const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) {
    const pixel = [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
    expect(pixel).toEqual(x >= 5 && x < 15 && y >= 5 && y < 15 ? [255, 0, 0] : [32, 64, 96]);
  }
});
