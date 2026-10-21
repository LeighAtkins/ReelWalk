import { createUpload } from "@/app/actions";
import { getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * The library upload (createUpload, then a PUT to storage, then confirm) as
 * plain HTTP, for scripts that run in a signed-in tab, such as seeding a
 * presenter kit (ADR 0056). Same checks as the editor's upload.
 */
export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return Response.json({ ok: false, error: "Sign in to upload." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(process.env.APP_URL || request.url).origin) return Response.json({ ok: false, error: "Invalid request origin." }, { status: 403 });
  const ticket = await createUpload(await request.json().catch(() => null));
  return Response.json(ticket, { status: ticket.ok ? 200 : 400 });
}
