import { describe, expect, it, vi } from "vitest";
import { emptyTimeline, instagramChoiceForSound, parseInstagramAudioChoice, recommendSoundVolume } from "@reelwalk/core";

// The row builders are pure; the module's other exports reach the database, the queue and the publisher.
vi.mock("@reelwalk/db", () => ({ prisma: {} }));
vi.mock("@/lib/render-capacity", () => ({ ensureWorkerRunning: async () => undefined }));
vi.mock("@/lib/render-jobs", () => ({ flushOutbox: async () => undefined, queueRenderJob: async () => "cloud", renderRouteFor: async () => "cloud" }));
vi.mock("@/lib/scheduled-posts", () => ({ publishDueScheduledPosts: async () => undefined }));

import { reelPostData, type PostableJob } from "./posting";

const user = { id: "u1", workspaceId: "w1" };
const job = { id: "job1", caption: null, reel: { id: "r1", title: "Villa", caption: "Every room in 15 seconds", featureConsent: false, featureHandle: null, timeline: emptyTimeline() } } as unknown as PostableJob;
const sound = { audioId: "1018160750329642", title: "Fresh Dance Club (Instrumental)", artist: "Last Jerónimo" };

describe("the post's sound (ADR 0066 follow-up)", () => {
  it("stores the recommended mix the export page offered: the Instagram sound at 100 % over the reel's own sound design at 60 %", () => {
    // What the export page builds when the trace recommends keeping the reel's sound design under the sound.
    const recommended = recommendSoundVolume({ integratedLufs: -15.9, hasSpeech: false, hasOwnSound: true });
    expect(recommended).toMatchObject({ audioVolume: 100, videoVolume: 60 });
    const choice = instagramChoiceForSound(sound, recommended);
    // What Post and Schedule do with the form's choice: parse it, then write the row.
    const row = reelPostData(user, job, { publishAt: new Date("2026-10-24T00:00:00+08:00"), audio: parseInstagramAudioChoice(choice), aiGenerated: false });
    expect(row).toMatchObject({ kind: "REEL", renderJobId: "job1", audioId: "1018160750329642", audioTitle: "Fresh Dance Club (Instrumental)", audioArtist: "Last Jerónimo", audioVolume: 100, videoVolume: 60 });
  });

  it("stores the default replacing mix for a reel with nothing of its own, and no sound fields without a sound", () => {
    const silent = instagramChoiceForSound(sound, recommendSoundVolume({ integratedLufs: null, hasSpeech: false, hasOwnSound: false }));
    expect(reelPostData(user, job, { publishAt: new Date(), audio: parseInstagramAudioChoice(silent), aiGenerated: true })).toMatchObject({ audioVolume: 100, videoVolume: 0, aiGenerated: true });
    const none = reelPostData(user, job, { publishAt: new Date(), audio: null, aiGenerated: false });
    expect("audioId" in none).toBe(false);
    expect(none.caption).toBe("Every room in 15 seconds");
  });
});
