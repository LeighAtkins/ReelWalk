/** The public address search engines and link previews should use: APP_URL when the deployment sets a real one, else the production site. */
export const SITE_URL = /^https?:\/\//.test(process.env.APP_URL ?? "") ? process.env.APP_URL!.replace(/\/$/, "") : "https://reelwalking.com";

/** The link-preview image (ADR 0081), 1200x630, built by e2e/scripts/build-og-image.mjs. Pages that set their own openGraph or twitter tags must name it again: those objects replace the layout's. */
export const OG_IMAGE = {
  url: "/og/reelwalk-1200x630.png",
  width: 1200,
  height: 630,
  alt: "A phone showing a ReelWalk listing reel, beside the words: Your listing, as a reel, in a minute.",
} as const;
