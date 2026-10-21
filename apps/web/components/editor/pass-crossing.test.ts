import { describe, expect, it } from "vitest";
import { createClock } from "./clock";
import { crossingNow } from "./pass-crossing";

describe("crossingNow", () => {
  it("reads the playhead when pressed, after playback has moved on since the sheet opened", () => {
    const clock = createClock();
    clock.set(4_000, "seek");
    // What the editor hands the sheet when it opens: the reader, not the value at that moment.
    const playheadNow = clock.get;
    // Playback advances behind the open sheet, 30 frames a second.
    for (let frame = 1; frame <= 37; frame++) clock.set(4_000 + (frame * 1000) / 30, "player");
    expect(crossingNow(playheadNow)).toBe(5_233);
    clock.set(5_734.6, "player");
    expect(crossingNow(playheadNow)).toBe(5_735);
  });

  it("never sets a negative time", () => {
    expect(crossingNow(() => -12)).toBe(0);
  });
});
