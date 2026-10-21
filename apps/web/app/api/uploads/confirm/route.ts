import { confirmUpload } from "@/app/actions";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/** Step 2 of the library upload as plain HTTP (see ../route.ts). */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to upload." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, error: "Invalid request origin." }, { status: 403 });
  const result = await confirmUpload(await request.json().catch(() => null));
  return Response.json(result, { status: result.ok ? 200 : 400 });
}
