import { describe, expect, it } from "vitest";
import { parseTimeline, scriptRequestSchema, type ScriptRequest, type Timeline } from "@reelwalk/core";
import type { LibraryAsset } from "@/lib/library";
import { createDocumentStore } from "./document-store";
import {
  APPROVAL_TTL_MS, approvalExpired, classifyAnswer, loadApproved, progressSummary, saveApproved, scriptProgress, scriptSettled, SCRIPT_IN_FLIGHT_LIMIT, sendApproval, shouldStartMore, startScript, takesToPlace,
  type ApprovalDeps, type ApprovedScript, type ScriptJob,
} from "./script-flow";

// Script mode in the editor (ADR 0060): following the takes, reading the server's answers, and placing them as one undo step.

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
const approved: ApprovedScript = { script, quotedCredits: 7, approvedAt: 1_000_000 };
const asset = (id: string, durationMs: number | null): LibraryAsset => ({ id, kind: "VIDEO", fileName: `${id}.mp4`, url: "", thumbUrl: null, durationMs, width: 1080, height: 1920, isPano: false, credit: null, tourId: null, spot: null, room: null, bpm: null, beatOffsetMs: null, previewPending: false } as LibraryAsset);
const job = (id: string, index: number, status: string, made: LibraryAsset | null = null): ScriptJob => ({ id, index, status, error: status === "FAILED" ? "Her face did not match." : status === "UNRESOLVED" ? "We couldn't confirm whether this take was made." : null, asset: made });

describe("following a script's takes", () => {
  it("reads each take's state from the script's own generations", () => {
    const progress = scriptProgress(approved, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4100)), job("g1", 1, "RUNNING")]);
    expect(progress.map((take) => take.state)).toEqual(["ready", "making", "waiting"]);
    expect(scriptSettled(progress)).toBe(false);
    expect(progressSummary(progress)).toBe("1 ready · 1 being made · 1 waiting its turn");
  });

  it("asks for the next take only when the workspace has room for it (the take queue, ADR 0069)", () => {
    const waiting = scriptProgress(approved, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "RUNNING")]);
    expect(shouldStartMore(waiting, SCRIPT_IN_FLIGHT_LIMIT)).toBe(false);
    expect(shouldStartMore(waiting, SCRIPT_IN_FLIGHT_LIMIT - 1)).toBe(true);
    expect(shouldStartMore(waiting, 2)).toBe(true);
    const all = scriptProgress(approved, [job("g0", 0, "RUNNING"), job("g1", 1, "RUNNING"), job("g2", 2, "QUEUED")]);
    expect(shouldStartMore(all, 0)).toBe(false);
  });

  it("says what happened to each credit: returned, held, spent or never used", () => {
    const progress = scriptProgress({ ...approved, script: { ...script, takes: [...script.takes, { ...script.takes[2], line: "One more thing." }] } }, [
      job("g0", 0, "FAILED"), job("g1", 1, "UNRESOLVED"), job("g2", 2, "SUCCEEDED", null),
    ]);
    expect(progress.map((take) => take.credit)).toEqual(["returned", "held", "spent", undefined]);
    expect(progressSummary(progress)).toBe("1 waiting its turn · 1 did not come out (credit returned) · 1 could not be confirmed (credit held, never charged twice) · 1 made but missing from your library");
    expect(progressSummary(progress)).not.toMatch(/held.*returned|missing.*returned/);
  });

  it("settles a stopped script: takes never started are not waited for and used no credit", () => {
    const stopped = { ...approved, stopped: { reason: "This script needs 3 more credits and 1 is left." } };
    const progress = scriptProgress(stopped, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "RUNNING")]);
    expect(progress.map((take) => [take.state, take.credit])).toEqual([["ready", undefined], ["making", undefined], ["failed", "none"]]);
    expect(progress[2].error).toMatch(/needs 3 more credits/);
    expect(scriptSettled(progress)).toBe(false);
    const done = scriptProgress(stopped, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "SUCCEEDED", asset("ai-g1", 8000))]);
    expect(scriptSettled(done)).toBe(true);
    expect(takesToPlace(script, done).map((take) => take.index)).toEqual([0, 1]);
  });

  it("places only what is ready when the studio stops early, and leaves failed takes out", () => {
    const early = scriptProgress(approved, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4100)), job("g1", 1, "RUNNING")]);
    expect(takesToPlace(script, early)).toEqual([{ assetId: "ai-g0", durationMs: 4100, afterClipId: null, fraction: 0, index: 0, trim: null }]);
    // A take the worker trimmed to its line (ADR 0069) is placed on that window.
    const trimmed = { ...asset("ai-g0", 4100), transcript: { text: "Welcome home.", words: [{ w: "Welcome", s: 300, e: 700 }, { w: "home.", s: 800, e: 1200 }], take: { line: "Welcome home.", startMs: 150, endMs: 1450, heard: "Welcome home.", distance: 0, wrongWords: false } } };
    expect(takesToPlace(script, scriptProgress(approved, [job("g0", 0, "SUCCEEDED", trimmed)]))[0].trim).toEqual({ startMs: 150, endMs: 1450 });
    const settled = scriptProgress(approved, [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4100)), job("g1", 1, "FAILED"), job("g2", 2, "SUCCEEDED", asset("ai-g2", null))]);
    expect(takesToPlace(script, settled)).toEqual([
      { assetId: "ai-g0", durationMs: 4100, afterClipId: null, fraction: 0, index: 0, trim: null },
      // Without a measured length the line's own (4 s) is used.
      { assetId: "ai-g2", durationMs: 4000, afterClipId: "b", fraction: 1, index: 2, trim: null },
    ]);
  });
});

describe("reading the server's answer", () => {
  it("tries again after no answer, a sign-out, a rate limit or a server error; stops after a refusal", () => {
    expect(classifyAnswer(202)).toBe("ok");
    for (const status of [null, 401, 408, 429, 500, 503]) expect(classifyAnswer(status)).toBe("transient");
    for (const status of [400, 403, 404, 409]) expect(classifyAnswer(status)).toBe("permanent");
  });

  it("asks again before starting more takes on an approval over an hour old", () => {
    expect(approvalExpired(approved, approved.approvedAt + APPROVAL_TTL_MS)).toBe(false);
    expect(approvalExpired(approved, approved.approvedAt + APPROVAL_TTL_MS + 1)).toBe(true);
  });
});

describe("sending the approval", () => {
  type Post = ApprovalDeps["post"];
  const harness = (post: Post, made: ScriptJob[] | null = []) => {
    const log: string[] = [];
    const saved: (ApprovedScript | null)[] = [];
    const deps: ApprovalDeps = {
      post: async (body) => { log.push(`post ${body.script.scriptId}`); return post(body); },
      jobs: async () => made,
      save: (next) => { log.push(next ? "save" : "forget"); saved.push(next); },
    };
    return { deps, log, saved };
  };

  it("keeps the script before it is sent, so a lost response is sent again with the same id, not charged as a new script", async () => {
    const lost = harness(async () => { throw new TypeError("Failed to fetch"); });
    const first = await startScript(script, 7, 5, lost.deps);
    expect(lost.log).toEqual(["save", `post ${script.scriptId}`]);
    expect(lost.saved[0]).toEqual({ script, quotedCredits: 7, approvedAt: 5 });
    expect(first).toMatchObject({ answer: "transient", approved: { script, quotedCredits: 7, approvedAt: 5 } });
    // The editor's next poll sends the same approval: the same script id, so the same request ids on the server.
    const again = await sendApproval(first.approved!, lost.deps);
    expect(lost.log.filter((entry) => entry.startsWith("post"))).toEqual([`post ${script.scriptId}`, `post ${script.scriptId}`]);
    expect(again.approved?.script.scriptId).toBe(script.scriptId);
    expect(lost.saved.filter((entry) => entry === null)).toEqual([]);
  });

  it("forgets the script only on a definite refusal with nothing made", async () => {
    const refused = harness(async () => ({ status: 409, data: { error: "The credit quote changed." } }), []);
    const result = await startScript(script, 7, 5, refused.deps);
    expect(result).toEqual({ answer: "permanent", approved: null, note: "The credit quote changed." });
    expect(refused.log).toEqual(["save", `post ${script.scriptId}`, "forget"]);
  });

  it("stops the rest but keeps what was made when a later take is refused, or when what was made cannot be read", async () => {
    const later = harness(async () => ({ status: 409, data: { error: "This script needs 2 more credits and 0 are left." } }), [job("g0", 0, "RUNNING")]);
    const result = await sendApproval(approved, later.deps);
    expect(result.approved).toEqual({ ...approved, stopped: { reason: "This script needs 2 more credits and 0 are left." } });
    expect(later.saved.at(-1)).toEqual(result.approved);
    const unknown = harness(async () => ({ status: 409, data: {} }), null);
    expect((await sendApproval(approved, unknown.deps)).approved?.stopped?.reason).toBe("The rest of the script could not be started.");
  });

  it("says when the hourly limit paused the rest", async () => {
    const paused = harness(async () => ({ status: 202, data: { paused: "hourly" } }));
    const result = await sendApproval(approved, paused.deps);
    expect(result.answer).toBe("ok"); expect(result.approved).toBe(approved);
    expect(result.note).toMatch(/hourly limit/);
  });
});

describe("placing the takes", () => {
  it("is one undo step through the document store, and undo takes it all back", () => {
    const store = createDocumentStore(reel(), () => ({ v1: 20000, v2: 20000 }));
    const jobs = [job("g0", 0, "SUCCEEDED", asset("ai-g0", 4000)), job("g1", 1, "SUCCEEDED", asset("ai-g1", 8000)), job("g2", 2, "SUCCEEDED", asset("ai-g2", 4000))];
    const outcome = store.runCommand({ type: "insertPresenterTakes", takes: takesToPlace(script, scriptProgress(approved, jobs)) });
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
  it("round-trips with its id and approval time, and ignores anything unreadable or from before approvals had a time", () => {
    const memory = new Map<string, string>();
    const storage = { getItem: (k: string) => memory.get(k) ?? null, setItem: (k: string, v: string) => void memory.set(k, v), removeItem: (k: string) => void memory.delete(k) };
    saveApproved("reel", approved, storage);
    expect(loadApproved("reel", storage)).toEqual(approved);
    memory.set("reelwalk:script:reel", JSON.stringify({ script, quotedCredits: 7 }));
    expect(loadApproved("reel", storage)).toBeNull();
    memory.set("reelwalk:script:reel", "{nope");
    expect(loadApproved("reel", storage)).toBeNull();
    saveApproved("reel", null, storage);
    expect(loadApproved("reel", storage)).toBeNull();
  });
});
