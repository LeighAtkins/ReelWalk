import sharp from "sharp";
import { furnitureStagePixels, type FurnitureStage } from "@reelwalk/core";

/** Restore the protected source outside the customer's edit area before final encoding. */
export async function compositeFurnitureStage(source: Buffer, generated: Buffer, stage: FurnitureStage, width = 1080, height = 1920): Promise<Buffer> {
  const rectangle = furnitureStagePixels(stage, width, height);
  const original = await sharp(source, { limitInputPixels: 40_000_000, failOn: "warning" }).rotate().resize(width, height, { fit: "cover", position: "centre" }).removeAlpha().png().toBuffer();
  const patch = await sharp(generated, { limitInputPixels: 20_000_000, failOn: "warning" }).rotate().resize(width, height, { fit: "cover", position: "centre" }).extract(rectangle).removeAlpha().png().toBuffer();
  return sharp(original).composite([{ input: patch, left: rectangle.left, top: rectangle.top }]).png().toBuffer();
}
