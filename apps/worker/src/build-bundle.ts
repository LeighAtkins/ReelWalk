import { performance } from "node:perf_hooks";
import { buildRenderBundle } from "@reelwalk/render/render-reel";

// Pre-build the Remotion webpack bundle at image build time (alongside ensure-browser.ts)
// so newly spawned workers do not pay a multi-second cold webpack bundle on their first export.
const started = performance.now();
const dir = await buildRenderBundle();
console.log(`Pre-built Remotion bundle at ${dir} in ${Math.round(performance.now() - started)}ms`);
