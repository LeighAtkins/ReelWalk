import { z } from "zod";
import { NAMED_EFFECTS } from "./title-effects";

/**
 * A board (ADR 0106): a grid of small video panels on a plain background, shown one column at a time, each panel
 * playing its own footage with its own label and title, all of a column at once. The reference (the owner's reel
 * 5019) shows sixteen title effects this way: a 4×4 board, four panels on screen together, the board sliding to the
 * next column, the opening shot shrinking into the first panel and the board dimming under a social outro.
 *
 * It is a layer over the reel, drawn above the clips and under the titles, between `startMs` and `endMs`. The clips
 * under it still set the reel's length and its sound; a panel's own footage is always silent.
 */

const ms = z.number().int().min(0);
const hex = z.string().regex(/^#[0-9a-f]{6}$/i);

export const BOARD_MAX_ROWS = 6;
export const BOARD_MAX_COLUMNS = 6;
export const BOARD_MAX_PANELS = BOARD_MAX_ROWS * BOARD_MAX_COLUMNS;

/** How a panel's keyword arrives: one of the sixteen effects (ADR 0103), typed out, a quick fade, or simply there. */
export const BOARD_KEYWORD_EFFECTS = ["none", "fadeQuick", "type", ...NAMED_EFFECTS] as const;
export type BoardKeywordEffect = (typeof BOARD_KEYWORD_EFFECTS)[number];

export const boardTitleSchema = z.object({
  /** The small line above the keyword ("try this"), in the board's text colour; empty for none. */
  lead: z.string().trim().max(40).default(""),
  /** The word or two that demonstrates the effect, in the keyword colour. */
  keyword: z.string().trim().min(1).max(40),
  effect: z.enum(BOARD_KEYWORD_EFFECTS).default("none"),
  /** Which side of the panel the words sit on; the subject is framed on the other. */
  side: z.enum(["left", "right"]).default("left"),
  /** How long after the panel's column comes into view the keyword starts arriving. */
  delayMs: ms.max(5000).default(0),
});
export type BoardTitle = z.infer<typeof boardTitleSchema>;

export const boardPanelSchema = z.object({
  id: z.string().min(1).max(64),
  /** The tiny caption above the panel ("Dot Hop"); empty for none. */
  label: z.string().trim().max(40).default(""),
  /** A video or picture from the library. */
  assetId: z.string().min(1),
  /** Where in the footage the panel starts playing when its column comes into view (the first column: when the board starts). */
  sourceStartMs: ms.default(0),
  /** Cover crops the shot; contain keeps a portrait shot whole over a softened copy of its background. */
  fit: z.enum(["cover", "contain"]).default("cover"),
  /** The point of the footage kept in the panel's crop (0..1 across and down). */
  focusX: z.number().min(0).max(1).default(0.5),
  focusY: z.number().min(0).max(1).default(0.5),
  /** A closer crop: 1 fills the panel, 2 shows the middle half. */
  zoom: z.number().min(1).max(4).default(1),
  /** Mirrored left to right about the panel's centre (after the crop), so the subject faces the words. */
  mirror: z.boolean().default(false),
  title: boardTitleSchema.optional(),
});
export type BoardPanel = z.infer<typeof boardPanelSchema>;

export const boardOutroSchema = z.object({
  /** Reel time the outro starts: the board dims and the glyph and handle come in. */
  atMs: ms,
  /** The handle under the glyph ("@reelwalking"). */
  handle: z.string().trim().min(1).max(40),
  /** The glyph above it: Instagram's, or none. */
  glyph: z.enum(["instagram", "none"]).default("instagram"),
  /** How bright the board stays under the outro (0 black, 1 undimmed). */
  dimTo: z.number().min(0).max(1).default(0.25),
});
export type BoardOutro = z.infer<typeof boardOutroSchema>;

export const boardSchema = z
  .object({
    /** Reel time the board starts (its entry begins) and ends. */
    startMs: ms,
    endMs: ms,
    rows: z.number().int().min(1).max(BOARD_MAX_ROWS),
    columns: z.number().int().min(1).max(BOARD_MAX_COLUMNS),
    /** Panels column by column: the first column top to bottom, then the second. Fewer than rows × columns leaves the rest empty. */
    panels: z.array(boardPanelSchema).min(1).max(BOARD_MAX_PANELS),
    /** Reel times each column after the first slides into view, ascending. Absent: the board's time in equal shares. */
    columnAtMs: z.array(ms).max(BOARD_MAX_COLUMNS - 1).optional(),
    /** How long a slide to the next column takes. */
    slideMs: z.number().int().min(0).max(1000).default(220),
    /** The full frame shrinks into the first panel over this long as the board starts; 0 cuts straight to the board. */
    entryMs: z.number().int().min(0).max(1500).default(250),
    /** During the entry the other panels of the first column fade in this far apart, top to bottom. */
    staggerMs: z.number().int().min(0).max(500).default(60),
    background: hex.default("#f8f6f1"),
    textColor: hex.default("#ffffff"),
    keywordColor: hex.default("#f2df3a"),
    /** Dark shade behind a panel's words, fading away before the presenter. Zero preserves older boards. */
    textShade: z.number().min(0).max(0.9).default(0),
    labelColor: hex.default("#5f5a52"),
    /** Panel corner radius, px of a 1080-wide frame. */
    radius: z.number().min(0).max(80).default(22),
    outro: boardOutroSchema.optional(),
  })
  .superRefine((board, ctx) => {
    if (board.endMs <= board.startMs) ctx.addIssue({ code: "custom", message: "The board must end after it starts.", path: ["endMs"] });
    if (board.panels.length > board.rows * board.columns) {
      ctx.addIssue({ code: "custom", message: `A ${board.rows}×${board.columns} board holds ${board.rows * board.columns} panels, not ${board.panels.length}.`, path: ["panels"] });
    }
    const ids = new Set<string>();
    for (const [index, panel] of board.panels.entries()) {
      if (ids.has(panel.id)) ctx.addIssue({ code: "custom", message: `Two panels are called ${panel.id}.`, path: ["panels", index, "id"] });
      ids.add(panel.id);
    }
    if (board.columnAtMs) {
      if (board.columnAtMs.length !== board.columns - 1) {
        ctx.addIssue({ code: "custom", message: `A board of ${board.columns} columns needs ${board.columns - 1} column times, not ${board.columnAtMs.length}.`, path: ["columnAtMs"] });
      }
      let previous = board.startMs + board.entryMs;
      for (const [index, at] of board.columnAtMs.entries()) {
        if (at <= previous || at >= board.endMs) {
          ctx.addIssue({ code: "custom", message: "Column times must rise, after the entry and before the board ends.", path: ["columnAtMs", index] });
          break;
        }
        previous = at;
      }
    }
    if (board.outro && (board.outro.atMs <= board.startMs || board.outro.atMs >= board.endMs)) {
      ctx.addIssue({ code: "custom", message: "The outro must start while the board is on screen.", path: ["outro", "atMs"] });
    }
  });
export type Board = z.infer<typeof boardSchema>;
/** A board as sent by an editor or an agent: the defaults (colours, timings, crops) may be left out. */
export type BoardInput = z.input<typeof boardSchema>;

/** The reel times each column comes into view (the first: the board's start). */
export function boardColumnStarts(board: Board): number[] {
  if (board.columnAtMs && board.columnAtMs.length === board.columns - 1) return [board.startMs, ...board.columnAtMs];
  const span = board.endMs - board.startMs;
  return Array.from({ length: board.columns }, (_, column) => Math.round(board.startMs + (span * column) / board.columns));
}

/** The panel in a column and row, or null for an empty cell. */
export function boardPanelAt(board: Board, column: number, row: number): BoardPanel | null {
  return board.panels[column * board.rows + row] ?? null;
}

export type BoardRect = { left: number; top: number; width: number; height: number };

/**
 * Where a column's panels sit in a frame (px), measured on the reference: panels 0.925 of the frame wide, centred,
 * stacked between 8.4% and 90.6% of its height with gaps of 3.7% (where each label sits). Fewer rows make taller
 * panels in the same band, never wider than a 16:9 strip.
 */
export function boardPanelRects(rows: number, width: number, height: number): BoardRect[] {
  const panelWidth = width * 0.925;
  const gap = height * 0.0373;
  const bandTop = height * 0.084, band = height * 0.822;
  const panelHeight = Math.min((band - (rows - 1) * gap) / rows, (panelWidth * 9) / 16);
  const used = rows * panelHeight + (rows - 1) * gap;
  const top = bandTop + (band - used) / 2;
  const left = (width - panelWidth) / 2;
  return Array.from({ length: rows }, (_, row) => ({ left, top: top + row * (panelHeight + gap), width: panelWidth, height: panelHeight }));
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));

export type BoardFrame = {
  /** How far the board has slid, in columns (1.5: halfway from the second column to the third). */
  scroll: number;
  /** The entry's progress 0..1: the first panel from the full frame to its place (1 once it has landed). */
  entry: number;
  /** The board's background opacity (it fades up behind the shrinking first panel). */
  backdrop: number;
  /** Brightness of the board under the outro, 1 before it. */
  brightness: number;
  /** The outro's glyph (scale 0..1 with a small overshoot) and handle (opacity). */
  glyph: number;
  handle: number;
  /** 0..1 along the glyph's colour pulse, for the gradient, while the outro holds. */
  pulse: number;
};

/** The board on one reel time (ms): the pure part of drawing it, shared by the renderer and its tests. */
export function boardFrame(board: Board, reelMs: number): BoardFrame {
  const starts = boardColumnStarts(board);
  let scroll = 0;
  for (let column = 1; column < starts.length; column++) {
    const p = board.slideMs > 0 ? clamp01((reelMs - starts[column]) / board.slideMs) : reelMs >= starts[column] ? 1 : 0;
    scroll += easeInOut(p);
  }
  // Fast out of the full frame, settling into the panel (the reference is half-way down a third of the way in).
  const entry = board.entryMs > 0 ? easeOut(clamp01((reelMs - board.startMs) / board.entryMs)) : 1;
  const backdrop = board.entryMs > 0 ? clamp01((reelMs - board.startMs) / (board.entryMs * 0.6)) : 1;
  let brightness = 1, glyph = 0, handle = 0, pulse = 0;
  if (board.outro && reelMs >= board.outro.atMs) {
    const t = reelMs - board.outro.atMs;
    brightness = 1 - (1 - board.outro.dimTo) * easeOut(clamp01(t / 300));
    // The glyph pops (to 1.12, back to 1) in 350 ms; the handle fades up from 250 ms; the colour pulses from 600 ms.
    const pop = clamp01(t / 350);
    glyph = board.outro.glyph === "none" ? 0 : pop < 0.6 ? easeOut(pop / 0.6) * 1.12 : 1.12 - 0.12 * easeInOut((pop - 0.6) / 0.4);
    handle = easeOut(clamp01((t - 250) / 300));
    pulse = t < 600 ? 0 : 0.5 - 0.5 * Math.cos(((t - 600) / 1800) * 2 * Math.PI);
  }
  return { scroll, entry, backdrop, brightness, glyph, handle, pulse };
}

/** A panel's fade-in during the entry: the first panel is there at once (it is the shrinking frame), the rest staggered. */
export function boardPanelEntryOpacity(board: Board, column: number, row: number, reelMs: number): number {
  if (column > 0 || row === 0 || board.entryMs === 0) return 1;
  // From the board's first frame, a row at a time, each over 150 ms: all of them are showing before the first panel lands.
  const from = board.startMs + (row - 1) * board.staggerMs;
  return easeOut(clamp01((reelMs - from) / 150));
}

/** Every library asset a board shows. */
export function boardAssetIds(board: Board | undefined | null): string[] {
  return board ? [...new Set(board.panels.map((panel) => panel.assetId))] : [];
}
