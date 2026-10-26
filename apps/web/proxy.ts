import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic sign-in check: a request without a session cookie goes to the
 * login page before any page code runs. The real check is in
 * lib/workspace.ts (getCurrentUser), which validates the session itself.
 */

const SESSION_COOKIE = "rw_session";

const PUBLIC_PATHS = [
  // The landing page and the plans: / is the marketing page without a session.
  /^\/$/,
  /^\/pricing$/,
  /^\/login$/,
  /^\/signup$/,
  /^\/forgot$/,
  /^\/reset\/[^/]+$/,
  /^\/r\/[^/]+$/,
  /^\/(privacy|terms|data-deletion|guide|connect)$/,
  // The MCP connector (ADR 0077): bearer-token endpoints and discovery documents, which are not browser pages.
  // /oauth/authorize is not listed: it is a page and sends a signed-out person to the login.
  /^\/mcp$/,
  /^\/oauth\/(register|token|revoke)$/,
  /^\/\.well-known\//,
  /^\/api\//,
  /^\/icon\.svg$/,
  // The brand mark, painted through a CSS mask on every page including sign-in.
  /^\/brand\//,
  // The landing page's photos and drawn screens.
  /^\/landing\//,
  // The link-preview image (ADR 0081): link crawlers and ad review fetch it without a session.
  /^\/og\//,
  /^\/robots\.txt$/,
  /^\/sitemap\.xml$/,
  /^\/manifest\.webmanifest$/,
];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
