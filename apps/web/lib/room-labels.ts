import { ROOM_NAMES } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { isAiConfigured, structuredAnswer, usageCostUsd, aiModel } from "@/lib/openai";
import { readObject } from "@/lib/storage";

/**
 * Names the room each of the studio's shots shows, by looking at it
 * (ADR 0021). Phones name files "IMG_4661", so without this the AI has
 * nothing to order the walk by or to label rooms with. One still per shot
 * (a video's thumbnail, a photo itself) goes to the model at low detail, all
 * in one request; the answer is kept on the media, so each shot is looked at
 * once. Shared library media and shots that already know their room are left
 * alone.
 */
/** What the model may answer: the studio's room names, and "other" when nothing fits. */
export const ROOMS = [...ROOM_NAMES, "other"] as const;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rooms"],
  properties: { rooms: { type: "array", items: { type: "string", enum: [...ROOMS] }, description: "One per picture, in order" } },
} as const;

const INSTRUCTIONS = `You look at stills from a real-estate listing shoot and name the room or place each one shows, one answer per picture, in the order given. Use "primary bedroom" for the largest or best-dressed bedroom, "bedroom" for others; "exterior" for the house seen from outside at ground level, "aerial" for drone shots, "view" for a scenic view with little of the house; "other" only when nothing fits.`;

/** Rooms named for the given media, by id; also stored on the media. */
export async function labelRooms(workspaceId: string, assetIds: string[], limit = 24): Promise<Record<string, string>> {
  if (!isAiConfigured() || assetIds.length === 0) return {};
  const rows = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, workspaceId, shared: false, room: null, kind: { in: ["IMAGE", "VIDEO"] } },
    select: { id: true, kind: true, objectKey: true, thumbKey: true },
    take: limit,
  });
  if (rows.length === 0) return {};
  const stills = await Promise.all(
    rows.map(async (row) => {
      const key = row.thumbKey ?? (row.kind === "IMAGE" ? row.objectKey : null);
      const object = key ? await readObject(key) : null;
      return object ? { id: row.id, url: `data:${object.contentType};base64,${object.bytes.toString("base64")}` } : null;
    }),
  );
  const seen = stills.filter((still): still is { id: string; url: string } => still !== null);
  if (seen.length === 0) return {};
  try {
    const answer = await structuredAnswer({
      workspaceId,
      instructions: INSTRUCTIONS,
      input: `${seen.length} pictures. Name the room in each.`,
      images: seen.map((still) => still.url),
      schemaName: "room_labels",
      schema: SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 600,
    });
    const rooms = (answer.json as { rooms?: unknown }).rooms;
    if (!Array.isArray(rooms)) return {};
    const named: Record<string, string> = {};
    await Promise.all(
      seen.map(async (still, index) => {
        const room = rooms[index];
        if (typeof room !== "string" || room === "other" || !(ROOMS as readonly string[]).includes(room)) return;
        named[still.id] = room;
        await prisma.mediaAsset.updateMany({ where: { id: still.id, room: null }, data: { room } });
      }),
    );
    console.log(`room labels: ${Object.keys(named).length} of ${seen.length} named, $${usageCostUsd(aiModel(), answer.usage).toFixed(4)}`);
    return named;
  } catch (error) {
    console.warn("room labels: not named", error instanceof Error ? error.message : error);
    return {};
  }
}
