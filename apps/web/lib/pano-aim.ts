import sharp from "sharp";
import { prisma } from "@reelwalk/db";
import { aiModel, isAiConfigured, structuredAnswer, usageCostUsd } from "@/lib/openai";
import { readObject } from "@/lib/storage";

/**
 * Where something is in a 360 photo (ADR 0025): "face the door", "look at
 * the view". The model is shown the whole equirectangular image with a
 * numbered grid drawn over it and asked how far across the picture the
 * thing sits, 0 at the left edge to 1 at the right; the camera heading that
 * centres it follows from the renderer's convention (heading 0 looks at the
 * middle of the image, positive turns clockwise, so a thing at fraction x
 * needs heading (x - 0.5) * 360).
 *
 * The full image, not the stored thumbnail: a library 360 photo's thumbnail
 * is a flat 59-degree window, which says nothing about where things are.
 */
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "x", "what"],
  properties: {
    found: { type: "boolean", description: "Whether the thing asked for is in the picture" },
    x: { type: "number", description: "How far across the picture its centre is, read off the grid: 0 = left edge, 0.5 = middle, 1 = right edge" },
    what: { type: "string", description: "What was found, in two or three words" },
  },
} as const;

const INSTRUCTIONS = `You look at one 360-degree photo of a room or place, shown as a flat equirectangular image: the full circle around the camera, so the left and right edges are the same direction, behind the camera. Thin vertical lines are drawn across it with their positions labelled at the top and bottom (0.1, 0.2 ... 0.9). The user names something in it: a door, a window, the view, the bed, the fireplace, the kitchen, the pool, the sea. Say whether it is there and read off the grid how far across the image its centre is, from 0 (left edge) to 1 (right edge), to two decimals. "The view" or "the sea" is where the outside is most visible (a glass door or window, an open side). If there are several, pick the most prominent. If it is not there, found is false.`;

const WIDTH = 1600;
const HEIGHT = 800;

/** Heading in degrees that looks straight at fraction `x` of the image. */
export function headingFor(x: number): number {
  return Math.round((Math.max(0, Math.min(1, x)) - 0.5) * 360);
}

/** The panorama, small, with a labelled grid every tenth of its width. */
async function gridded(bytes: Buffer): Promise<Buffer> {
  const lines = Array.from({ length: 9 }, (_, i) => {
    const x = Math.round(((i + 1) / 10) * WIDTH);
    const label = `0.${i + 1}`;
    return `<line x1="${x}" y1="0" x2="${x}" y2="${HEIGHT}" stroke="#ff2d55" stroke-width="2" stroke-opacity="0.75"/>
      <rect x="${x - 24}" y="4" width="48" height="26" rx="4" fill="#000" fill-opacity="0.7"/><text x="${x}" y="24" font-family="Arial" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>
      <rect x="${x - 24}" y="${HEIGHT - 30}" width="48" height="26" rx="4" fill="#000" fill-opacity="0.7"/><text x="${x}" y="${HEIGHT - 10}" font-family="Arial" font-size="20" font-weight="700" fill="#fff" text-anchor="middle">${label}</text>`;
  }).join("");
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${lines}</svg>`);
  return sharp(bytes).resize(WIDTH, HEIGHT, { fit: "fill" }).composite([{ input: svg }]).jpeg({ quality: 78 }).toBuffer();
}

/** The heading that faces `target` in the 360 photo `assetId`, or null when it is not there or cannot be looked at. */
export async function aimPano(workspaceId: string, assetId: string, target: string): Promise<{ heading: number; what: string; x: number } | null> {
  if (!isAiConfigured()) return null;
  const asset = await prisma.mediaAsset.findFirst({ where: { id: assetId, kind: "IMAGE", OR: [{ workspaceId }, { shared: true }] }, select: { objectKey: true } });
  if (!asset) return null;
  const object = await readObject(asset.objectKey, 40 * 1024 * 1024);
  if (!object) return null;
  try {
    const image = await gridded(object.bytes);
    const answer = await structuredAnswer({
      workspaceId,
      instructions: INSTRUCTIONS,
      input: `Where is: ${target.slice(0, 60)}`,
      images: [`data:image/jpeg;base64,${image.toString("base64")}`],
      imageDetail: "high",
      schemaName: "pano_aim",
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 600,
    });
    const json = answer.json as { found?: boolean; x?: number; what?: string };
    console.log(`pano aim: "${target}" -> ${json.found ? `${json.what} at ${json.x}` : "not found"}, $${usageCostUsd(aiModel(), answer.usage).toFixed(4)}`);
    if (!json.found || typeof json.x !== "number") return null;
    return { heading: headingFor(json.x), what: json.what ?? target, x: json.x };
  } catch (error) {
    console.warn("pano aim failed", error instanceof Error ? error.message : error);
    return null;
  }
}
