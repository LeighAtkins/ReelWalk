import path from "node:path";
import { fileURLToPath } from "node:url";

/** The seeded demo studio the suite signs in to (DEMO_PASSWORD in docker-compose.yml). */
export const DEMO_EMAIL = "demo@reelwalk.local";
export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? "reelwalk-demo";
export const demoState = path.join(path.dirname(fileURLToPath(import.meta.url)), ".auth", "demo.json");

/**
 * A studio of its own for the tests that connect the pretend Instagram
 * (ADR 0054). The connection is studio-wide: on the shared demo studio one
 * test's clean-up disconnected it under the others running beside it, and
 * while connected it changes the Music sheet and the AI's song list for every
 * other test. auth.setup.ts signs this studio up and connects it once a run.
 */
export const instagramState = path.join(path.dirname(fileURLToPath(import.meta.url)), ".auth", "instagram.json");
