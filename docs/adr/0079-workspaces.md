# 79. One sign-in, several workspaces

Date: 2026-10-25

## Context

Leigh runs ReelWalk (`@reelwalking`) and a game, Last Mile (`@playlastmile`).
He wants one ReelWalk sign-in that can work in both, each with its own reels,
media library, brand kit (ADR 0078), AI credits and billing view, Instagram
posting identity and scheduled posts. "Use the lastmile account connected to my
personal reelwalk account. If we can't connect two accounts add that option to
reelwalk."

A `User` belonged to exactly one `Workspace` (`User.workspaceId`), and the app
reads the workspace from the signed-in user in well over a hundred places
(`user.workspaceId` in routes, actions and library code; the connector's tools
from ADR 0077 the same). Everything that is per workspace already hangs off
`Workspace` with `workspaceId` columns: reels, media, tours, exports, scheduled
posts, AI credit grants and generations, presenters, the plan and Stripe ids,
and the Instagram `SocialAccount` (`@@unique([workspaceId, provider])`, so each
workspace has its own connection). What was missing was a person who can act
in more than one, a way to say which, and a way to switch an AI cost centre off.

## Decision

### 1. Memberships

`WorkspaceMember { userId, workspaceId, role OWNER|EDITOR, createdAt }`,
unique on `(userId, workspaceId)`. `User.workspaceId` stays: it is the **home
workspace** (what a fresh sign-in lands in, the fallback for everything below,
and what the older scripts and the worker's import tools read). The migration
backfills one OWNER row per existing user from `User.workspaceId`; signup writes
one; the seed writes one. Code does not rely on the backfill having run for the
home workspace: `seatsFor()` always lists the home workspace as the person's
(OWNER when its row is missing), which also covers an account created by an
older web instance during the deploy window.

Roles: owners change a workspace's settings (name, AI switch) and billing;
editors work in its reels. There is no invite flow yet, so an EDITOR row can only
be made by hand; the role exists so adding one later does not need another
migration.

### 2. The active workspace

`getSessionUser()` (`lib/auth.ts`) is the one door every page, route and action
already uses, and it now returns the user **acting in their active workspace**:
`user.workspaceId` and `user.workspace` are the active workspace, with
`user.homeWorkspaceId` and `user.role` (the seat in the active one) added. So
nothing that scopes by `user.workspaceId` changes.

The active workspace is a **preference** the browser keeps in a signed, httpOnly,
SameSite=Lax cookie `rw_workspace`: `<workspaceId>.<HMAC-SHA256(sessionToken,
"rw-workspace:<userId>:<workspaceId>")>`. The key is the session's own random
token, so the value is good for this session and this person only, and no new
secret exists to manage. On every request the cookie is verified, **and** the
workspace must be one the person still holds a seat in (`WorkspaceMember`, plus
home); otherwise the home workspace is used. A forged, replayed, stale or
revoked cookie therefore cannot widen what a person can reach. A new sign-in and
sign-out clear it.

`switchWorkspace` (a server action) checks the seat, sets the cookie and lands on
`/` (a reel id of one workspace does not exist in the other). Deleting an
account now removes every workspace the person is the last soul in (home
included), their seat in shared ones, and the files of all of them.

**Audit.** `grep` for `workspaceId` reads: everything in `apps/web` goes through
`getSessionUser`/`getCurrentUser` (pages, routes, actions, `lib/*` that take a
user) or through a workspace id already taken from a row (webhooks, the
scheduled-post loop, the worker). The exceptions that were not, and what became of them:

| Place | Was | Now |
|---|---|---|
| `quotas.isUnlimited` | admin who has the workspace as home | admin who has it as home or holds a seat |
| `scheduled-posts.notifyFailed` | the workspace's first user (by home) | the person who made the post, else the first owner seat |
| `auth-actions.deleteAccount` | counted users by home | counts users and seats; deletes every workspace left empty |
| `auth-actions.updateProfile` | renamed the workspace | renames it only for an owner |
| `billing-actions` | any user | owners only (checkout, top-up, portal) |
| MCP `loadUser` | the person's home workspace | `actingUserFor(userId, grant.workspaceId)` (below) |

The worker is unaffected: jobs carry their `workspaceId`.

### 3. The switcher

Phone first, no script. `WorkspaceSwitcher` is a `<details>` in the Reels header,
shown only to someone with more than one workspace: the current name, then one
48 px row per workspace, each a form posting to `switchWorkspace`. **Account →
Workspaces** lists them, shows the AI switch with a toggle for owners, and has
**Create a workspace** (a name; the person becomes OWNER, at most 5 per sign-in,
not for the shared demo account; it opens the new workspace at once). Each
workspace's Instagram connection, scheduled posts, plan, AI credits and billing
view are already its own (`SocialAccount` unique per workspace), so `@playlastmile`
is connected from Account while Last Mile is the active workspace.

### 4. The AI switch

`Workspace.aiGeneration`: `"on"` (default) or `"off"`. Off means no model request,
no AI video and no credit movement for that workspace, enforced where a provider
can be reached, not only in the UI:

- **`createAiGeneration`** (Veo shots, drafts, finals, presenter takes, director
  approvals, the connector's `generate_ai_shot`): `assertAiOn` first, before the
  reservation of credits.
- **`structuredAnswer`** (every model call: Ask, the director, autopilot,
  script/hook/caption/text ideas, room labels, pano aiming, shoot planner, stock
  frame checks, the surface finder's vision look, the performance reference):
  the options now **require `workspaceId`** and the function asserts the switch
  before it picks a provider. A new caller cannot skip it without a type error.
- **Routes** that start AI work answer `403 { ok: false, code: "ai_off",
  message }` right after the sign-in check, before reading the body:
  `/api/ai/generations`, `/api/ai/performance`, `/api/ai/surface-regions`, and under
  `/api/reels/:id/`: `ai-edit`, `autopilot`, `director`, `director/generate`,
  `director/runs/:runId`, `ideas` (every kind but the song list), `rooms`, `script`.
  `aiEditBlockedReason` (used by Ask and the shoot planner) answers the same
  message, so Ask on the export screen and "Plan my shoot" say why (the planner still
  hands back its standard list, which asks nothing). A test lists every route that
  imports an AI module and fails if one is neither guarded nor exempt with a reason.
- **Degrades instead of failing** where AI is only a bonus: the surface finder
  falls back to its edge finder with no vision look; stock search returns "unchecked"
  (not cached for other workspaces).
- **The UI hides it**: no Ask box, polish, briefs, AI video, Presenter, Redo/New take,
  Ask Opus in the editor (`aiOff` flows into the controls' rules), no Ask for a change
  on the export screen, and `/ai-video` and the Account AI card say it is off.
  Buying AI credits is also refused for a workspace with AI off.

The AI-off message: *AI generation is turned off for this workspace. An owner can
turn it on under Account, Workspaces.*

### 5. The connector (ADR 0077) is bound to a workspace

- `OAuthGrant.workspaceId` (required), unique on `(userId, clientId, workspaceId)`:
  the same app can be connected to two workspaces as two grants with their own tokens.
- The consent screen shows a workspace picker (radio rows) when the person has more
  than one, defaulting to the active workspace; one workspace is a hidden field.
  The decision route requires a seat in the workspace named by the form (else 403,
  nothing granted). Changing workspace later means disconnecting and connecting
  again; the screen and `list_workspaces` say so.
- Every access token resolves, **on every call**, through `actingUserFor(userId,
  grant.workspaceId)`: the user is loaded, the seat re-checked (a person removed from
  the workspace gets `invalid_token` on the next call), and the user object handed
  to `runAsUser` has the grant's workspace as `workspaceId`/`workspace`. So all
  tools, and the editor code they call, run in that workspace with no per-tool change.
- **`list_workspaces`** (scope `reels:read`, read-only): the bound workspace and the
  person's other workspaces (id, name, role, `aiGeneration`) with a note that switching
  means reconnecting.
- **Consent defaults** (`lib/mcp/consent.ts`, one rule for page, decision and tests):
  `ai:generate` is **unticked by default even when the app requested it**; if the
  chosen workspace has AI off it is **not offered at all and never granted** (the
  decision route strips it server-side, so a forged form gets nothing; a request for
  `ai:generate` alone is a cancel). A token also loses `ai:generate` at use time if the
  workspace turns AI off after consent. `generate_ai_shot` itself refuses with
  `ai_off` before quoting.
- Account → Connected apps shows the workspace each connection acts in, and the public `/connect` help page explains the choice.

### 6. Admin step

`apps/web/scripts/create-workspace.mts` (logic in `lib/admin-workspace.ts`) gives an
**existing account** a new workspace. Not run against production by this change.

```
DATABASE_URL=<prod url> pnpm -C apps/web tsx scripts/create-workspace.mts \
  --email leigh.atkins1@gmail.com --name "Last Mile" --slug last-mile --ai off --brand-kit last-mile
```

Add `--dry-run` first. It creates the workspace (AI off, brand kit copied onto
`Workspace.brandKit`) and an OWNER seat for that email; the person's home workspace,
sessions and data are untouched. Running it twice only re-sets the AI switch and
kit. A slug belonging to a workspace the person has no seat in is refused.
**`--brand-kit` needs ADR 0078 in the build** (`Workspace.brandKit` and
`BUNDLED_BRAND_KITS`); on a build without it the script refuses before changing
anything and says to create the workspace without the flag and assign the kit later
with `scripts/brand-kit.mts assign` (ADR 0078), which is what happens if this
lands first.

## Migration

**There is a Prisma migration: `20261025030000_workspaces`. `ship.sh` does not
apply migrations; `prisma migrate deploy` must be run before the web deploy that
contains this change, or sign-in, the account page and the connector fail** (the
session query now includes the seats). Its content:

- enum `WorkspaceRole`; `Workspace.aiGeneration TEXT NOT NULL DEFAULT 'on'`
  (every existing workspace keeps AI on);
- table `WorkspaceMember` (+ unique and index, cascades from both sides) and a
  **backfill**: one OWNER row per existing `User` for its `workspaceId`;
- `OAuthGrant.workspaceId`: added nullable, **backfilled from the person's home
  workspace**, then `NOT NULL` + foreign key; the unique index
  `(userId, clientId)` is replaced by `(userId, clientId, workspaceId)`.

Existing connector grants keep working and keep acting in the person's home
workspace. Rolling back the code before the migration is safe; rolling back the
migration needs the old unique index recreated by hand (one grant per person and
app, so any second grant must be deleted first).

## Consequences

- One request costs one extra row set in the session query (the seats), and a
  second workspace row when a non-home workspace is active. No new request.
- The cookie is per browser. A second browser starts at the home workspace.
- "Switching" a connector means reconnecting; a connector token cannot move
  workspaces by itself, by design (a leaked token is bounded to one workspace).
- `structuredAnswer`'s required `workspaceId` is an API change for any future
  caller (a type error, not a runtime surprise). AI work already queued before
  a workspace turns AI off is not recalled; the durable worker's own provider calls
  carry no switch check (they were gated when they were created).
- EDITOR seats exist in the schema and are enforced for settings and billing, but
  nothing creates them yet.
- The Meta app review, ad accounts and Stripe customers remain per workspace; the
  Last Mile Instagram connection still needs the Meta app to allow that account.

## Not done

- No invite or "remove a member" flow; no UI to rename or delete a non-home workspace
  (renaming works on the active one from the profile form for owners).
- Not clicked through in a browser or against a real phone (see Verified).
- `scripts/mcp-smoke.mts` was not re-run against `next dev` (it needs a signed-in
  cookie and a stack); the consent form it submits now carries one extra `workspace`
  field.

## Verified

See the pull request for the exact commands and their output.
