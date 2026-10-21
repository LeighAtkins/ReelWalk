import { describe, expect, it } from "vitest";
import { parseTimeline, scriptRequestSchema, type ScriptRequest, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { createDocumentStore } from "./document-store";
import { loadApproved, progressSummary, saveApproved, scriptProgress, scriptSettled, shouldStartMore, takesToPlace, type ScriptJob } from "./script-flow";

// Script mode in the editor (ADR 0060): following the takes and placing them as one undo step.

function reel(): Timeline {
  return parseTimeline({
    version: 1,
    clips: [
      { id: "a", assetId: "v1", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "entry" },
      { id: "b", assetId: "v2", kind: "VIDEO", sourceStartMs: 0, sourceEndMs: 4000, room: "kitchen" },
    ],
    texts: [{ id: "t", text: "Kitchen", startMs: 4500, endMs: 6000 }],
    music: null,
  });
}
const script: ScriptRequest = scriptRequestSchema.parse({
  scriptId: "8c7d4c2e-6a1f-4b7e-9d3a-1e2f3a4b5c6d", presenterId: "kit",
  takes: [
    { line: "Welcome in.", boundary: 0, afterClipId: null, fraction: 0, plate: { assetId: "v1", atMs: 0 } },
    { line: "The kitchen is where everyone ends up at every party.", boundary: 1, afterClipId: "a", fraction: 0.5, plate: { assetId: "v1", atMs: 3967 } },
    { line: "Message me for a tour.", boundary: 2, afterClipId: "b", fraction: 1, plate: { assetId: "v2", atMs: 3967 } },
  ],
});
const asset = (id: string, durationMs: number | null): LibraryAsset => ({ id, kind: "VIDEO", fileName: `${id}.mp4`, url: "", thumbUrl: null, durationMs, width: 1080, height: 1920, isPano: false, credit: null, tourId: null, spot: null, room: null, bpm: null, beatOffsetMs: null, previewPending: false } as LibraryAsset);
const job = (id: string, index: number, status: string, made: LibraryAsset | null = null, scriptId = script.scriptId): ScriptJob => ({ id, status, error: status === "FAILED" ? "Her face did not match." : null, shot: { mode: "custom", script: { id: scriptId, index } }, asset: made });

describe("following a script's takes", () => {
  it("reads each take's state from the generations, matched by script and line", () => {
    const jobs = [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4100)), job("g1", 1, "RUNNING"), job("other", 2, "SUCCEEDED", asset("ai-x", 4000), "11111111-1111-4111-8111-111111111111")];
    const progress = scriptProgress(script, jobs);
    expect(progress.map((take) => take.state)).toEqual(["ready", "making", "waiting"]);
    expect(scriptSettled(progress)).toBe(false);
    expect(progressSummary(progress)).toBe("1 ready · 1 being made · 1 waiting its turn");
  });

  it("asks for the next take only when the workspace has room for it", () => {
    const busy = [job("g0", 0, "RUNNING"), job("g1", 1, "QUEUED")];
    expect(shouldStartMore(scriptProgress(script, busy), busy)).toBe(false);
    const freed = [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "RUNNING")];
    expect(shouldStartMore(scriptProgress(script, freed), freed)).toBe(true);
    const all = [...freed, job("g2", 2, "QUEUED")];
    expect(shouldStartMore(scriptProgress(script, all), all)).toBe(false);
  });

  it("settles with failed takes left out of what is placed", () => {
    const jobs = [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4100)), job("g1", 1, "FAILED"), job("g2", 2, "SUCCEEDED", asset("ai-g2", null))];
    const progress = scriptProgress(script, jobs);
    expect(scriptSettled(progress)).toBe(true);
    expect(takesToPlace(script, progress)).toEqual([
      { assetId: "ai-g0", durationMs: 4100, afterClipId: null, fraction: 0, index: 0 },
      // Without a measured length the line's own (4 s) is used.
      { assetId: "ai-g2", durationMs: 4000, afterClipId: "b", fraction: 1, index: 2 },
    ]);
  });
});

describe("placing the takes", () => {
  it("is one undo step through the document store, and undo takes it all back", () => {
    const store = createDocumentStore(reel(), () => ({ v1: 20000, v2: 20000 }));
    const jobs = [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "SUCCEEDED", asset("ai-g1", 8000)), job("g2", 2, "SUCCEEDED", asset("ai-g2", 4000))];
    const outcome = store.runCommand({ type: "insertPresenterTakes", takes: takesToPlace(script, scriptProgress(script, jobs)) });
    expect(outcome.rejected).toBeUndefined();
    const state = store.getState();
    expect(state.history.past).toHaveLength(1);
    expect(state.history.present.clips.map((clip) => clip.id)).toEqual(["script-ai-g0", "a", "script-ai-g1", "b", "script-ai-g2"]);
    // The kitchen title stays over the kitchen clip, which now starts at 16 s.
    expect(state.history.present.texts[0]).toMatchObject({ startMs: 16500, endMs: 18000 });
    store.dispatch({ type: "undo" });
    expect(store.getState().history.present).toEqual(reel());
  });
});

describe("keeping the approved script", () => {
  it("round-trips through storage and ignores anything unreadable", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    saveApproved("reel", { script, quotedCredits: 7 }, storage);
    expect(loadApproved("reel", storage)).toEqual({ script, quotedCredits: 7 });
    memory.set("reelwalk:script:reel", "{nope");
    expect(loadApproved("reel", storage)).toBeNull();
    saveApproved("reel", null, storage);
    expect(loadApproved("reel", storage)).toBeNull();
  });
});
