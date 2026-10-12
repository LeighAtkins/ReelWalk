import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { publishDueScheduledPosts } from "@/lib/scheduled-posts";

export const dynamic = "force-dynamic";

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * One publisher tick on demand (ADR 0017). EventBridge calls this every
 * minute with "Authorization: Bearer <SCHEDULER_SECRET>", which gives an App
 * Runner instance the CPU the in-process loop does not get while idle.
 * Without the secret configured the endpoint does not exist.
 */
export async function POST(request: Request): Promise<Response> {
  const secret = process.env.SCHEDULER_SECRET;
  // Terraform stores an absent secret as "unset" (Parameter Store refuses empty values).
  if (!secret || secret === "unset" || secret.length < 16) return new NextResponse(null, { status: 404 });
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!timingSafeEqual(digest(given), digest(secret))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const result = await publishDueScheduledPosts();
  if (!result) return NextResponse.json({ ok: false }, { status: 500 });
  return NextResponse.json({ ok: true, ...result }, { headers: { "cache-control": "no-store" } });
}
