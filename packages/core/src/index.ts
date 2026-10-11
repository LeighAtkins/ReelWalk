import { z } from "zod";

// Zod compiles parsers with `new Function` unless told not to. The web app's
// Content-Security-Policy forbids eval, so every page that parsed a schema
// logged a violation; jitless parsing avoids it at no noticeable cost.
z.config({ jitless: true });

export * from "./autobuild";
export * from "./beats";
export * from "./drag";
export * from "./instagram";
export * from "./job-status";
export * from "./keys";
export * from "./plan";
export * from "./queue";
export * from "./reel-export";
export * from "./timeline";
export * from "./uploads";
export * from "./venue";
export * from "./vibes";
export * from "./walk";
