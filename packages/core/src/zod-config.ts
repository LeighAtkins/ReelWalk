import { z } from "zod";

// Zod compiles parsers with `new Function` unless told not to, and probes for
// it on the first parse. The web app's Content-Security-Policy forbids eval,
// so the probe was reported as a violation on every page that parsed a
// schema. Jitless parsing skips both, at no noticeable cost.
z.config({ jitless: true });
