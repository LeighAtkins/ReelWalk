/** The public address search engines and link previews should use: APP_URL when the deployment sets a real one, else the production site. */
export const SITE_URL = /^https?:\/\//.test(process.env.APP_URL ?? "") ? process.env.APP_URL!.replace(/\/$/, "") : "https://reelwalking.com";
