import { brandKitSchema, type BrandKit } from "../brand-kit";

/**
 * The "Last Mile" kit (ADR 0078): the look of the game Last Mile: 7 Days and its @playlastmile reels. Data, not UI:
 * the editor and the agent tools read whatever kit a workspace has; this one is given to a workspace by the admin script
 * (`apps/web/scripts/brand-kit.mts`), and no other workspace sees it.
 *
 * Colours are the game's own palette. Sizes are fractions of the title's font size, so a style scales with the text:
 * the title card's magenta shadow is 12 x 10 px at a 250 px size (0.048 x 0.04 em); the captions' 3 px edge is 0.0526 em at the
 * 57 px caption size. Big Shoulders Display ships no slant axis, so the forward slant is a skew (see `TextTreatment.slant`).
 */
const MAGENTA_SHADOW = { dx: 0.048, dy: 0.04, color: "#ff2bd6" } as const;

export const LAST_MILE_KIT: BrandKit = brandKitSchema.parse({
  id: "last-mile",
  name: "Last Mile",
  fonts: ["big-shoulders-display", "chakra-petch", "atkinson-hyperlegible", "anton", "caveat-brush"],
  palette: [
    { id: "ink", hex: "#07080e", group: "interface", note: "Backgrounds and caption plates" },
    { id: "ink-lift", hex: "#161826", group: "interface" },
    { id: "ink-edge", hex: "#2a2d44", group: "interface" },
    { id: "magenta", hex: "#ff2bd6", group: "interface", note: "The hard shadow of titles; caption edges" },
    { id: "cyan", hex: "#22e6ff", group: "interface", note: "Labels; the alternate caption edge" },
    { id: "acid", hex: "#e8ff3a", group: "interface", note: "Punchlines" },
    { id: "paper", hex: "#f3f1ff", group: "interface", note: "Title and caption text" },
    { id: "muted", hex: "#a3a1c2", group: "interface" },
    { id: "safety-yellow", hex: "#ffc21a", group: "hero" },
    { id: "yellow-shade", hex: "#e3a000", group: "hero" },
    { id: "charcoal", hex: "#25272c", group: "hero" },
    { id: "tape-red", hex: "#e5392e", group: "hero" },
    { id: "cargo-cream", hex: "#f0e3c8", group: "hero" },
    { id: "eye-cyan", hex: "#7ff5ff", group: "hero" },
    { id: "neon-violet", hex: "#8a4dff", group: "neon" },
    { id: "neon-pink", hex: "#ff5a8c", group: "neon" },
  ],
  styles: [
    {
      name: "lastmile-title",
      label: "Title",
      description: "The title card (LAST MILE): paper letters, Big Shoulders Display 900 leaning forward, a hard magenta offset shadow. Type it in capitals; one to three words.",
      color: "#f3f1ff",
      size: 2.5,
      tracking: 0.02,
      look: { font: "big-shoulders-display", weight: 900, slant: 10, shadow: MAGENTA_SHADOW },
    },
    {
      name: "lastmile-caption",
      label: "Caption",
      description: "Spoken-line captions and narration: Atkinson Hyperlegible Bold in paper on an ink plate (85%) with a 3 px magenta edge.",
      color: "#f3f1ff",
      size: 0.75,
      tracking: 0.01,
      look: { font: "atkinson-hyperlegible", weight: 700, plate: { color: "#07080e", opacity: 0.85, edge: { width: 0.0526, color: "#ff2bd6" }, radius: 0.12, padX: 0.5, padY: 0.28 } },
    },
    {
      name: "lastmile-caption-cyan",
      label: "Caption (cyan)",
      description: "The same caption with a cyan edge: for a second voice, a system message or a callback.",
      color: "#f3f1ff",
      size: 0.75,
      tracking: 0.01,
      look: { font: "atkinson-hyperlegible", weight: 700, plate: { color: "#07080e", opacity: 0.85, edge: { width: 0.0526, color: "#22e6ff" }, radius: 0.12, padX: 0.5, padY: 0.28 } },
    },
    {
      name: "lastmile-punchline",
      label: "Punchline",
      description: "The line the joke lands on: acid-yellow Big Shoulders Display 900, leaning forward, with the magenta hard shadow. Short, in capitals.",
      color: "#e8ff3a",
      size: 2.1,
      tracking: 0.02,
      look: { font: "big-shoulders-display", weight: 900, slant: 10, shadow: MAGENTA_SHADOW },
    },
    {
      name: "lastmile-label",
      label: "Label",
      description: "Small tech labels (DAY 3, 06:42, ROUTE B): Chakra Petch SemiBold in cyan, capitals, wide-set.",
      color: "#22e6ff",
      size: 0.7,
      tracking: 0.14,
      look: { font: "chakra-petch", weight: 600, caps: true },
    },
    {
      name: "lastmile-label-paper",
      label: "Label (paper)",
      description: "The label in paper white, for a label that sits on a cyan or bright picture.",
      color: "#f3f1ff",
      size: 0.7,
      tracking: 0.14,
      look: { font: "chakra-petch", weight: 600, caps: true },
    },
    {
      name: "lastmile-sign",
      label: "Signage",
      description: "Shop-front and street signage: Anton in cargo cream with a hard charcoal shadow.",
      color: "#f0e3c8",
      size: 1.6,
      tracking: 0.04,
      look: { font: "anton", weight: 400, caps: true, shadow: { dx: 0.05, dy: 0.05, color: "#25272c" } },
    },
    {
      name: "lastmile-scrawl",
      label: "Scrawl",
      description: "Handwritten notes on the world (a scribble on a wall): Caveat Brush in paper with a hard tape-red shadow.",
      color: "#f3f1ff",
      size: 1.4,
      look: { font: "caveat-brush", weight: 400, slant: 4, shadow: { dx: 0.04, dy: 0.04, color: "#e5392e" } },
    },
  ],
});
