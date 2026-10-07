import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

let buildId: string | null = null;

/** The running build, so an open editor can tell when ReelWalk was updated under it. */
export async function GET() {
  buildId ??= (await readFile(path.join(process.cwd(), ".next", "BUILD_ID"), "utf8").catch(() => "dev")).trim();
  return Response.json({ build: buildId }, { headers: { "cache-control": "no-store" } });
}
