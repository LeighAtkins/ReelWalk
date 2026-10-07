# ADR 0012: Accounts with passwords and database sessions

Status: accepted (2026-10-07)

## Context

Until now every request acted as one seeded demo user. To hand the app to
anyone else it needs sign-up, sign-in and separation between studios. The
first version has to work on a phone over plain HTTP on a home network,
needs no email provider or OAuth app to exist yet, and must leave the door
open for both later.

## Decision

- **Email and password.** Passwords are hashed with scrypt from Node's
  `crypto` (`packages/db/src/password.ts`), parameters stored with the hash.
  No native dependency, nothing to install in the worker image.
- **Sessions in Postgres.** Signing in writes a `Session` row and sets an
  httpOnly cookie holding a random token. The table stores only the token's
  SHA-256, so a database read-out does not yield working sessions. Thirty
  days, no sliding renewal. Sign-out deletes the row; other devices stay in.
- **Cookies are `secure` only over HTTPS.** `AUTH_SECURE_COOKIES` forces it;
  otherwise it follows `APP_URL`. Local Compose and phones on the LAN run on
  HTTP and still work.
- **One gate.** `getCurrentUser()` in `apps/web/lib/workspace.ts` resolves
  the session or redirects to `/login`. `proxy.ts` does a cheap cookie check
  first so signed-out visitors never run page code. The legacy desktop
  editor's API keeps working through `getApiUser()`, which falls back to the
  demo workspace because nginx already protects it with basic auth.
- **One workspace per user.** Sign-up creates a workspace named after the
  studio or the person. Teams and invitations are not in scope yet.
- **The starter library is shared, not copied.** Open-library media rows are
  flagged `shared` and visible to every workspace through `mediaScope()`;
  uploads stay private to their workspace. The ZInD tours stay with the demo
  workspace because their licence is local-only.
- **A demo studio stays one tap away** when `DEMO_PASSWORD` is set, which
  Compose does and a public deployment should not.

## Consequences

- The Playwright suite signs in once (`auth.setup.ts`) and reuses the cookie.
- Adding magic links or Google sign-in later means another way to call
  `createSession()`, not a new session model.
- Password reset needs an email provider and does not exist yet; the account
  page can change a known password.
