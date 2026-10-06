import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic sign-in check: a request without a session cookie goes to the
 * login page before any page code runs. The real check is in
 * lib/workspace.ts (getCurrentUser), which validates the session itself.
 */

const SESSION_COOKIE = "rw_session";

const PUBLIC_PATHS = [/^\/login$/, /^\/signup$/, /^\/r\/[^/]+$/, /^\/api\//, /^\/icon\.svg$/, /^\/manifest\.webmanifest$/];

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATHS.some((pattern) => pattern.test(pathname))) return NextResponse.next();
  if (request.cookies.has(SESSION_COOKIE)) return NextResponse.next();

  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
