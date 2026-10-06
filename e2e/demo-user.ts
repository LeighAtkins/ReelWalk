import path from "node:path";
import { fileURLToPath } from "node:url";

/** The seeded demo studio the suite signs in to (DEMO_PASSWORD in docker-compose.yml). */
export const DEMO_EMAIL = "demo@reelwalk.local";
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? "reelwalk-demo";
export const demoState = path.join(path.dirname(fileURLToPath(import.meta.url)), ".auth", "demo.json");
