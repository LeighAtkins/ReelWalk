import { z } from "zod";
import { getSessionUser } from "@/lib/auth";
import { AiError, isAiAvailable } from "@/lib/openai";
import { MINUTE, countAttempt, overLimit } from "@/lib/throttle";
import { lookForSurfaces } from "@/lib/surface-vision";

export const runtime = "nodejs";

/**
 * The vision half of "Put on a surface" for the editor (ADR 0075): one composition frame (the editor cuts it
 * through the frame service, so it shows the clip's fit, zoom and move) goes to the model, which names the flat
 * surfaces and their kinds. The answer is rough corners and labels only: the editor puts them on the picture's
 * real edges and ranks them with `findSurfaces` in the browser. Nothing is stored.
 */
const input = z.object({ frame: z.string().startsWith("data:image/jpeg;base64,").max(900_000) });

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ error: "Sign in to look for surfaces." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ error: "Invalid request origin." }, { status: 403 });
  if (!isAiAvailable()) return Response.json({ error: "Naming surfaces is not set up on this deployment." }, { status: 409 });
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send one JPEG frame as a data URL." }, { status: 400 });
  // A look costs a model call: thirty a minute per person is far above what tapping through shots needs.
  const limits = [{ key: `surface-regions:${user.id}`, max: 30, windowMs: MINUTE }];
  if (await overLimit(limits)) return Response.json({ error: "That is a lot of looks at once. Wait a minute and try again." }, { status: 429 });
  await countAttempt(limits);
  try {
    const bytes = Buffer.from(parsed.data.frame.slice("data:image/jpeg;base64,".length), "base64");
    const look = await lookForSurfaces(bytes);
    return Response.json({ regions: look.hints.regions ?? [], horizonY: look.hints.horizonY ?? null, model: look.model, costUsd: look.costUsd, ms: look.ms }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof AiError ? error.message : "The surfaces could not be named." }, { status: 502 });
  }
}
