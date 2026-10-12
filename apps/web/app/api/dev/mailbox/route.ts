import { NextResponse, type NextRequest } from "next/server";
import { devMailboxFor, isEmailConfigured } from "@/lib/email";

/**
 * The messages the app would have emailed, for the end-to-end tests on the
 * local stack. Exists only when DEV_MAILBOX=true and no email provider is
 * configured; a public deployment answers 404.
 */
export async function GET(request: NextRequest) {
  if (process.env.DEV_MAILBOX !== "true" || isEmailConfigured()) return new NextResponse(null, { status: 404 });
  const to = request.nextUrl.searchParams.get("to") ?? "";
  return NextResponse.json({ messages: devMailboxFor(to) }, { headers: { "cache-control": "no-store" } });
}
