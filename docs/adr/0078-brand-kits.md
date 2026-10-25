# 78. Brand kits: a workspace's own fonts, palette and named text styles

Date: 2026-10-25

## Context

Titles in ReelWalk draw in four bundled faces (Cormorant Garamond, Bodoni Moda,
Archivo, Noto Sans JP) and a fixed set of six text styles; everything else is a
per-title field. That suits ReelWalk's own channel, whose house rule bans boxed
text, and it does not suit anyone with a look of their own:

- Leigh's game *Last Mile: 7 Days* makes its @playlastmile reels through ReelWalk
  over the MCP connector (ADR 0077). The brand is a slanted condensed display face
  with a hard magenta offset shadow, ink caption plates with a coloured edge, and a
  small palette. An agent can only reach that today by hand-setting a dozen fields
  per title, and cannot at all for the fonts, the hard shadow, the plate edge or the
  slant, which the title model does not have.
- Real-estate agencies have brand colours and fonts. This is a product feature.

The house rule against boxed text is for the ReelWalk channel only. A brand kit must
be able to carry plates and edges, because brands do.

## Decision

A **brand kit** is data on the workspace: bundled fonts it may use, a palette, and
named **text styles**. A style is applied to a title by name, with one command, and
the title then carries a self-contained copy of the look.

### The title model (additive)

`TextOverlay` gets one optional field, `brand` (`textTreatmentSchema`,
`packages/core/src/brand-fonts.ts`):

| Field | Meaning |
|---|---|
| `style` | The kit style it came from (`lastmile-title`), so the editor can show which is on |
| `font`, `weight` | A bundled brand face; a variable font takes any weight in range (`brandFontHasWeight`) |
| `slant` | Degrees the letters lean forward, -20..20 (a **faux** slant: a `skewX`, see below) |
| `italic` | The family's own italic face, where it ships one (Atkinson Hyperlegible) |
| `caps` | Set in capitals (the measure is told, so a lower-case label is measured as drawn) |
| `shadow` | `{dx, dy, color}`: a **hard offset shadow**, no blur |
| `plate` | `{color, opacity, edge?: {width, color}, radius?, padX?, padY?}`: a filled box with an optional edge |

Lengths are fractions of the font size, so the look scales with the text: the title
card's shadow is 12 x 10 px at a 250 px size, stored as 0.048 x 0.04 em. Colour,
size and tracking are the title's existing `color`, `size` and `tracking`.

Applying a style sets `style: "plain"`, the kit's colour/size/tracking and `brand`.
Where `brand` is present the composition replaces the style's own face, shadow,
contrast edge and plate with it (`brandCss`, `packages/render/src/reel/look.ts`).
**Saved reels have no `brand`, so they parse and render exactly as before**
(tested: no `brand` key on parse, round trip equal, CSS for the six built-in styles
unchanged). Because the treatment is copied onto the title, a saved reel needs
neither the kit nor the workspace to render, and editing a kit later never
re-styles reels already made.

### Fonts in the composition

Five families, all **SIL Open Font License 1.1**, bundled in
`packages/render/src/reel/brand-fonts/` as the unmodified upstream TTFs with each
family's `OFL.txt` beside it and a `NOTICE.md` (the copyright lines are also
`BRAND_FONT_NOTICE` in core):

| Family | Files | Use |
|---|---|---|
| Big Shoulders Display | variable (wght 100-900) | titles, punchlines |
| Chakra Petch | Medium, SemiBold, Bold | labels |
| Atkinson Hyperlegible | Regular, Bold, Italic | captions |
| Anton | Regular | signage |
| Caveat Brush | Regular | scrawl |

They are declared by `@font-face` in `brand-fonts.css`, imported by `fonts.ts`
beside the Fontsource CSS the composition already loads, so the Player, the
worker's Remotion bundle and the Next build all take the same route; nothing is
installed on the worker host and no fontconfig is involved. `useFontsFor` takes the
title's brand family and holds the frame until it is loaded, as it does for the
other faces; a font is downloaded only when a title that uses it is drawn.
Unmodified files means the licence's Reserved Font Name clause is not engaged (we do
not rename or modify them). `.gitattributes` marks `*.ttf` binary.

**Slant.** Big Shoulders Display has only a `wght` axis (checked with fontTools:
`wght 100-900`, default 100), so there is no `slnt` to drive. The forward lean is a
`skewX(-slant deg)` on the title, and it also tilts a plate if the style has both;
Chrome's synthetic oblique was not used because its angle is not ours to choose.
The two composition spots that set their own `transform` on the title (a title
painted on a surface, and the slide of "from behind" type) append the lean.

### The kit (stored additively)

`Workspace.brandKit Json?`, one nullable column. A kit (`brandKitSchema`,
`packages/core/src/brand-kit.ts`) is `{id, name, fonts[], palette[], styles[]}`; a
style is `{name, label, description, color, size, tracking?, look}`. The schema
checks every style's font is in the kit's `fonts`, names and palette ids are unique,
weights exist in the font, and colours are hex. `readBrandKit` returns null for a
missing or invalid value, so a bad kit never breaks the editor.

I chose a JSON column over a `BrandKit` table because there is exactly one kit per
workspace, it is read whole and written whole, and it is validated in the app. A
table would add a join and a second migration shape for nothing; it can be split out
if kits ever become shared or versioned.

The **Last Mile** kit is data (`packages/core/src/brand-kits/last-mile.ts`, validated
at import): the game's palette (16 colours in three groups) and eight styles:
`lastmile-title`, `lastmile-caption`, `lastmile-caption-cyan`, `lastmile-punchline`,
`lastmile-label`, `lastmile-label-paper`, plus the optional `lastmile-sign` (Anton)
and `lastmile-scrawl` (Caveat Brush). It is in `BUNDLED_BRAND_KITS`, which only the
admin script reads: **nothing in the app or the seed gives it to a workspace**, and
`workspaceBrandKit(workspaceId)` returns that workspace's own column only.

Admin step (needs the migration applied):

```
DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts assign <workspace slug | user email> last-mile
DATABASE_URL=... pnpm -C apps/web tsx scripts/brand-kit.mts show   <workspace slug | user email>
```

`assign <who> <file.json>` takes any kit, validated first; `--dry` checks without
writing; `remove` clears it (reels already styled keep their look).

### The command, HTTP and MCP

`{ type: "applyTextStyle", textId, style: "<name>" | null }` is a document command
(`packages/core/src/commands.ts`), in `COMMAND_TYPES`, so the commands route and
the MCP `apply_commands` tool accept it with no further wiring. It is checked
against the workspace's kit, which `CommandContext.brandKit` carries (the route and
the editor's store both pass it): no kit, an unknown style or a missing text is
refused with the reason (for an unknown style, the names the kit does have), and a
batch containing it is all or nothing. `style: null` takes the style off. **Dry-run**
is the existing `dryRun: true` on the commands route and `apply_commands`.
A style already on the text is a no-op, not an undo step.

Discovery: `get_reel` now carries `brandKit` (id, name, style names) and each text's
`brandStyle`; a new read-only MCP tool **`get_brand_kit`** (scope `reels:read`)
returns the palette, fonts and every style with its exact look and a description of
when to use it (`style: "<name>"` narrows it). The MCP instructions and the house
style hint now say a kit's named styles replace the "no boxed text" rule for that
workspace. `workspaceBrandKit` swallows a failed read (including a database that
does not have the column yet) and answers "no kit".

### The editor

In the text sheet, a **Brand** row appears only for a workspace that has a kit: a
chip per style, each in its own face, plus "No brand style". One tap sets font,
colour, size, shadow and plate through the same `resolveTextStyle` the command uses;
Save is the sheet's one undo step. Picking a built-in Style, a Typeface or a Text
shadow takes the brand style off (they would otherwise be silently overridden). The
sheet's live preview draws the brand look.

## Consequences

- **Migration: yes.** `20261025020000_brand_kit`: `ALTER TABLE "Workspace" ADD COLUMN
  "brandKit" JSONB;` Additive, nullable, no backfill. **`ship.sh` does not apply
  migrations.** Until it is applied the app still works (reads answer "no kit"); only
  the admin script's `assign` needs the column.
- A kit's styles are a recipe copied at apply time; changing the kit does not
  re-style old titles. To restyle a reel, apply the style again.
- The treatment is plain data in the timeline, so a client that saves a timeline
  directly can set `brand` without a kit; that is fine (the fonts are bundled and
  public, the shape is validated by the schema). The kit gates the *named, validated*
  application and what an agent can discover, not what the renderer can draw.
- The faux slant skews the whole title element, so a slanted plate leans too. The
  Last Mile styles do not combine them.
- 1.2 MB of fonts in the repo and the worker image; each is fetched by the browser
  only when a title uses it.
- Text-fit and the critic's geometry do not know about the hard shadow or the plate
  edge (a 9 px shadow at the title size); the safe zones are generous enough.

## What was verified

Run on one machine under the shared-PC heavy lock, in a fresh worktree (`pnpm install --frozen-lockfile`, `db:generate`):

- `pnpm check` (eslint, typecheck of all 9 workspaces, all tests): exit 0. core 97 files / 1225 tests, render 21 / 110, worker 16 / 200, web 27 / 252, db 4 / 12 (2 db files skipped: they need a live Postgres).
- New tests: `packages/core/tests/brand-kit.test.ts` (registry weights, treatment schema refusals, the Last Mile kit's spec: 12 x 10 px shadow at 250 px, weight 900, 85% ink plate, 3 px edge in magenta/cyan, every colour in the palette; kit validation; style resolution and the unknown-name message; the command's apply / refuse / `null` / batch-atomic / no-op cases; saved-reel parity: no `brand` key on parse, round trip equal) and `packages/render/tests/brand-css.test.ts` (the CSS of each style, scaling with size, the six built-in styles' CSS unchanged, the measure told about capitals).
- `pnpm --filter @reelwalk/web build`: exit 0 (the `.ttf` files and `brand-fonts.css` go through Next's CSS pipeline).
- Worker entry import check (`import("./src/index.ts")` under tsx): printed `OK`.
- Render: `packages/render/scripts/brand-stills.ts` adds five plain titles to a reel and applies the Last Mile styles with the real `applyTextStyle` command, then draws frame 24 at 1080 x 1920 through `renderReelStills`, the composition the preview and the export share (Remotion's webpack bundle, headless Chrome): `docs/adr/assets/0078-lastmile-styles.png`. By eye against the spec: Big Shoulders Display 900 title leaning forward in paper with a hard magenta offset shadow down and to the right and no blur; the punchline the same in acid; captions in Atkinson Hyperlegible Bold on an ink plate with a thin magenta (and cyan) edge; the label in cyan Chakra Petch capitals with wide tracking. The font files are loaded by the composition, not the machine (the box has none of them installed).

## What was not verified

- The migration was not run against a database, and `scripts/brand-kit.mts` was not run (no local Postgres in this session): `assign`/`show`/`remove` are typechecked and linted, and the kit they write is the one the tests validate.
- The editor's Brand row was not exercised in a browser (no workspace has a kit locally). `withBrandStyle` is the same `resolveTextStyle` the command tests cover, and the sheet compiles and builds.
- The worker image was not built (no docker builds today). The Remotion bundle that the render above used is the one the worker builds, and `packages/render` is copied whole into the image, but a render inside the container is unverified.
- The MCP `get_brand_kit` tool and the `get_reel` additions are covered by the tool-list tests (schema, naming, no-post rule) but not by a call against a workspace that has a kit.
- Fonts were not checked on a real phone's Player (Safari/Chrome mobile).
