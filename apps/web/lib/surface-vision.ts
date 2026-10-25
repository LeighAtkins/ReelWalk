import sharp from "sharp";
import { SURFACE_REGIONS_INSTRUCTIONS, SURFACE_REGIONS_SCHEMA, parseSurfaceRegions, type SurfaceHints } from "@reelwalk/core";
import { AiError, aiModel, isAiAvailable, structuredAnswer, usageCostUsd, type AiUsage } from "@/lib/openai";

/**
 * The vision half of "Put text on a surface" (ADR 0075): one picture, drawn with a faint 10% grid so the
 * model can read positions off it, goes through the same `structuredAnswer` path the room labels and the
 * performance reference use (no new provider). It names the flat surfaces and their kinds; the corners are
 * then pulled onto real edges by `findSurfaces`, so a model that is a few percent off costs nothing.
 */
export type SurfaceLookResult = { hints: SurfaceHints; model: string; usage: AiUsage; costUsd: number; ms: number };

/** The picture the model sees: the frame at 576 wide with a line every 10%, the 50% lines heavier. */
export async function griddedFrame(jpeg: Buffer, width = 576): Promise<string> {
  const base = sharp(jpeg).resize({ width, withoutEnlargement: false });
  const { data, info } = await base.jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
  const lines: string[] = [];
  for (let i = 1; i < 10; i++) {
    const heavy = i === 5;
    const stroke = `stroke="#ffffff" stroke-opacity="${heavy ? 0.7 : 0.38}" stroke-width="${heavy ? 2 : 1}"`;
    lines.push(`<line x1="${(info.width * i) / 10}" y1="0" x2="${(info.width * i) / 10}" y2="${info.height}" ${stroke}/>`, `<line x1="0" y1="${(info.height * i) / 10}" x2="${info.width}" y2="${(info.height * i) / 10}" ${stroke}/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${info.width}" height="${info.height}">${lines.join("")}</svg>`;
  const out = await sharp(data).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).jpeg({ quality: 80 }).toBuffer();
  return `data:image/jpeg;base64,${out.toString("base64")}`;
}

export const surfaceVisionAvailable = (): boolean => isAiAvailable();

/** Asks the model for the surfaces in a frame (a JPEG of the composition, any size). Throws `AiError` when the model cannot answer. */
export async function lookForSurfaces(jpeg: Buffer, signal?: AbortSignal): Promise<SurfaceLookResult> {
  const started = Date.now();
  const image = await griddedFrame(jpeg);
  const answer = await structuredAnswer({
    instructions: SURFACE_REGIONS_INSTRUCTIONS,
    input: "Mark the flat surfaces in this picture where a title could be painted.",
    images: [image],
    imageDetail: "high",
    schemaName: "surface_regions",
    schema: SURFACE_REGIONS_SCHEMA as unknown as Record<string, unknown>,
    maxOutputTokens: 900,
    signal,
  });
  const model = answer.model || aiModel();
  const costUsd = usageCostUsd(model, answer.usage);
  console.log(`surfaces: ${(answer.json as { regions?: unknown[] })?.regions?.length ?? 0} regions, ${answer.usage.inputTokens} in / ${answer.usage.outputTokens} out, $${costUsd.toFixed(4)} (${model})`);
  return { hints: parseSurfaceRegions(answer.json), model, usage: answer.usage, costUsd, ms: Date.now() - started };
}

export { AiError };
