import { describe, expect, it } from "vitest";
import { parseTimeline, type Timeline } from "@reelwalk/core";
import { runAutopilot, type AutopilotCut } from "./autopilot-flow";
import { createDocumentStore, STALE_PROPOSAL } from "./document-store";
import { landProposal, REJECTED_PROPOSAL } from "./proposals";

// "Make it for me" against the real document store: the polish is made from
// the input of the first cut that was accepted, against that cut's generation.

const shot = (id: string) => ({ id, assetId: id, kind: "IMAGE" as const, sourceStartMs: 0, sourceEndMs: 3000 });
const reel = (ids: string[]): Timeline => parseTimeline({ version: 1, clips: ids.map(shot), texts: [], music: null });
const ids = (timeline: Timeline) => timeline.clips.map((clip) => clip.id);

function harness() {
  const store = createDocumentStore(reel(["a", "b", "c"]));
  const events: string[] = [];
  const polishInputs: string[][] = [];
  const steps = {
    snapshot: store.snapshot,
    // A cut by rule: the shots it was given, reversed.
    quick: async (from: Timeline): Promise<AutopilotCut> => ({ ok: true, timeline: { ...from, clips: [...from.clips].reverse() } }),
    polish: async (from: Timeline): Promise<AutopilotCut> => {
      polishInputs.push(ids(from));
      return { ok: true, timeline: { ...from, clips: [...from.clips].sort((x, y) => x.id.localeCompare(y.id)) } };
    },
    takeIn: (cut: AutopilotCut & { ok: true }, baseGeneration: number) => landProposal({ ...store, fetchSound: async () => null }, baseGeneration, cut.timeline),
  };
  const record = {
    fail: (message: string) => events.push(`fail: ${message}`),
    draft: () => events.push("draft"),
    polished: () => events.push("polished"),
    polishStale: () => events.push("polish stale"),
    polishFailed: (message: string) => events.push(`polish failed: ${message}`),
  };
  return { store, events, polishInputs, steps, record };
}

describe("make it for me", () => {
  it("a clip removed while the first cut was made is not brought back by the polish", async () => {
    const { store, events, polishInputs, steps, record } = harness();
    let first = true;
    const quick = async (from: Timeline) => {
      // The studio (or a room name) changes the reel while the first request is out.
      if (first) {
        first = false;
        store.runCommand({ type: "deleteClip", clipId: "b" });
      }
      return steps.quick(from);
    };
    await runAutopilot({ ...steps, quick }, record, STALE_PROPOSAL);
    expect(events).toEqual(["draft", "polished"]);
    // The retry and the polish both worked from the reel without b.
    expect(polishInputs).toEqual([["a", "c"]]);
    expect(ids(store.getState().history.present)).toEqual(["a", "c"]);
  });

  it("an edit after the first cut makes the polish stale, and the studio's version stays", async () => {
    const { store, events, steps, record } = harness();
    const polish = async (from: Timeline) => {
      store.runCommand({ type: "deleteClip", clipId: "a" });
      return steps.polish(from);
    };
    await runAutopilot({ ...steps, polish }, record, STALE_PROPOSAL);
    expect(events).toEqual(["draft", "polish stale"]);
    expect(ids(store.getState().history.present)).toEqual(["c", "b"]);
  });

  it("a first cut that is not a valid reel fails instead of opening a draft", async () => {
    const { store, events, steps, record } = harness();
    const quick = async (): Promise<AutopilotCut> => ({ ok: true, timeline: { version: 2 } });
    await runAutopilot({ ...steps, quick }, record, STALE_PROPOSAL);
    expect(events).toEqual([`fail: ${REJECTED_PROPOSAL}`]);
    expect(store.getState().history.past).toHaveLength(0);
  });

  it("a polish that is not a valid reel keeps the first cut and says so", async () => {
    const { store, events, steps, record } = harness();
    const polish = async (): Promise<AutopilotCut> => ({ ok: true, timeline: { version: 1, clips: "nope" } });
    await runAutopilot({ ...steps, polish }, record, STALE_PROPOSAL);
    expect(events).toEqual(["draft", `polish failed: The first cut stays: ${REJECTED_PROPOSAL}`]);
    expect(ids(store.getState().history.present)).toEqual(["c", "b", "a"]);
  });

  it("gives up with the stale message when the reel keeps changing under the first cut", async () => {
    const { store, events, steps, record } = harness();
    let n = 0;
    const quick = async (from: Timeline) => {
      store.runCommand({ type: "moveClip", clipId: "a", toIndex: ++n % 3 });
      return steps.quick(from);
    };
    await runAutopilot({ ...steps, quick }, record, STALE_PROPOSAL);
    expect(events).toEqual([`fail: ${STALE_PROPOSAL}`]);
  });
});
