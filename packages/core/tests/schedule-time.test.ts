import { describe, expect, it } from "vitest";
import { POST_SPACING_MS, defaultScheduleLocal, isValidTimeZone, publishAtProblem, spacingWarning, toZonedLocal, zonedLocalToUtc, zoneOffsetMinutes } from "../src";

const iso = (date: Date | null) => date?.toISOString() ?? null;

describe("zonedLocalToUtc", () => {
  it("converts a wall time in a fixed-offset zone", () => {
    expect(iso(zonedLocalToUtc("2026-10-13T09:00", "Asia/Tokyo"))).toBe("2026-10-13T00:00:00.000Z");
    expect(iso(zonedLocalToUtc("2026-10-13T09:00", "UTC"))).toBe("2026-10-13T09:00:00.000Z");
  });

  it("uses the offset in force on that date, not today's", () => {
    // New York is UTC-4 in summer and UTC-5 in winter.
    expect(iso(zonedLocalToUtc("2026-07-01T09:00", "America/New_York"))).toBe("2026-07-01T13:00:00.000Z");
    expect(iso(zonedLocalToUtc("2026-12-01T09:00", "America/New_York"))).toBe("2026-12-01T14:00:00.000Z");
    // London: BST in summer, GMT in winter.
    expect(iso(zonedLocalToUtc("2026-07-01T09:00", "Europe/London"))).toBe("2026-07-01T08:00:00.000Z");
    expect(iso(zonedLocalToUtc("2026-12-01T09:00", "Europe/London"))).toBe("2026-12-01T09:00:00.000Z");
  });

  it("handles half-hour zones and the date line", () => {
    expect(iso(zonedLocalToUtc("2026-10-13T09:00", "Asia/Kolkata"))).toBe("2026-10-13T03:30:00.000Z");
    expect(iso(zonedLocalToUtc("2026-10-13T00:30", "Pacific/Auckland"))).toBe("2026-10-12T11:30:00.000Z");
  });

  it("moves a time skipped by the spring change forward by the gap", () => {
    // 2026-03-08 in New York: 02:00 EST jumps to 03:00 EDT.
    expect(iso(zonedLocalToUtc("2026-03-08T02:30", "America/New_York"))).toBe("2026-03-08T07:30:00.000Z");
    expect(toZonedLocal(zonedLocalToUtc("2026-03-08T02:30", "America/New_York")!, "America/New_York")).toBe("2026-03-08T03:30");
  });

  it("takes the first of a time that happens twice in the autumn", () => {
    // 2026-11-01 in New York: 01:30 EDT, then 01:30 EST an hour later.
    expect(iso(zonedLocalToUtc("2026-11-01T01:30", "America/New_York"))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("refuses malformed input, impossible dates and unknown zones", () => {
    expect(zonedLocalToUtc("2026-10-13 09:00", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-02-31T09:00", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-10-13T24:00", "UTC")).toBeNull();
    expect(zonedLocalToUtc("2026-10-13T09:00", "Mars/Olympus_Mons")).toBeNull();
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("round-trips with toZonedLocal", () => {
    for (const zone of ["Asia/Tokyo", "America/Los_Angeles", "Europe/Berlin", "Australia/Adelaide"]) {
      for (const local of ["2026-01-15T07:45", "2026-06-30T23:59", "2026-10-13T00:00"]) {
        expect(toZonedLocal(zonedLocalToUtc(local, zone)!, zone)).toBe(local);
      }
    }
  });
});

describe("zoneOffsetMinutes", () => {
  it("is east-positive", () => {
    expect(zoneOffsetMinutes(new Date("2026-10-13T00:00:00Z"), "Asia/Tokyo")).toBe(540);
    expect(zoneOffsetMinutes(new Date("2026-07-01T00:00:00Z"), "America/New_York")).toBe(-240);
  });
});

describe("publishAtProblem", () => {
  const now = new Date("2026-10-12T12:00:00Z");

  it("accepts a time a few minutes to sixty days ahead", () => {
    expect(publishAtProblem(new Date("2026-10-12T12:05:00Z"), now)).toBeNull();
    expect(publishAtProblem(new Date("2026-12-10T12:00:00Z"), now)).toBeNull();
  });

  it("refuses the past, the next minute and beyond sixty days", () => {
    expect(publishAtProblem(new Date("2026-10-12T11:00:00Z"), now)).toMatch(/minutes from now/);
    expect(publishAtProblem(new Date("2026-10-12T12:01:00Z"), now)).toMatch(/minutes from now/);
    expect(publishAtProblem(new Date("2026-12-12T12:00:00Z"), now)).toMatch(/60 days/);
  });
});

describe("defaultScheduleLocal", () => {
  it("is tomorrow at 09:00 in the viewer's zone", () => {
    // 23:30 UTC on the 12th is already the 13th in Tokyo.
    const now = new Date("2026-10-12T23:30:00Z");
    expect(defaultScheduleLocal(now, "UTC")).toBe("2026-10-13T09:00");
    expect(defaultScheduleLocal(now, "Asia/Tokyo")).toBe("2026-10-14T09:00");
    expect(defaultScheduleLocal(new Date("2026-12-31T12:00:00Z"), "UTC")).toBe("2027-01-01T09:00");
  });
});

describe("spacingWarning", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 9, 22, 9, minutes));
  const reelAt = (minutes: number, title = "Villa") => ({ publishAt: at(minutes), kind: "REEL" as const, title });

  it("is quiet when the nearest post is an hour or more away", () => {
    expect(spacingWarning(at(0), [])).toBeNull();
    expect(spacingWarning(at(0), [reelAt(60), reelAt(-60)])).toBeNull();
  });

  it("names the nearest post inside the hour, before or after, and counts the rest", () => {
    expect(spacingWarning(at(0), [reelAt(24, "Lodge")])).toBe(
      "the reel “Lodge” is set to go out 24 minutes after. Posts closer than an hour share Instagram's first batch of viewers; an hour apart each gets its own.",
    );
    expect(spacingWarning(at(30), [reelAt(29), reelAt(59), reelAt(100)])).toMatch(/^the reel “Villa” is set to go out 1 minute before \(1 more within the hour\)\./);
    expect(spacingWarning(at(0), [{ publishAt: at(0), kind: "STORY", title: null }])).toMatch(/^a story is set to go out at the same time\./);
    expect(spacingWarning(at(0), [{ publishAt: at(10), kind: "REEL", title: null }])).toMatch(/^another reel is set to go out 10 minutes after\./);
  });

  it("takes a different window", () => {
    expect(spacingWarning(at(0), [reelAt(40)], 30 * 60_000)).toBeNull();
    expect(POST_SPACING_MS).toBe(60 * 60_000);
  });
});
