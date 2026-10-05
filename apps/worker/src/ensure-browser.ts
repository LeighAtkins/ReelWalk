import { ensureRenderBrowser } from "@reelwalk/render/ensure-browser";

// Run during the image build, from the same working directory the worker
// uses at runtime, so Remotion finds the browser it downloaded here.
await ensureRenderBrowser();
console.log("Chrome Headless Shell is installed");
