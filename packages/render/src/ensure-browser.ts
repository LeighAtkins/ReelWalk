import { ensureBrowser } from "@remotion/renderer";

export async function ensureRenderBrowser(): Promise<void> {
  await ensureBrowser();
}
