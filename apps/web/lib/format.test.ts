import { describe, expect, it } from "vitest";
import { formatAgo, formatDateTime } from "./format";

describe("Australian date format (ADR 0081)", () => {
  it("writes day before month, in UTC", () => {
    expect(formatDateTime(new Date("2026-10-04T07:08:00Z"))).toBe("4 Oct, 07:08 UTC");
  });

  it("falls back to day and month for anything older than a week", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    expect(formatAgo(new Date("2026-10-04T07:08:00Z"), now)).toBe("4 Oct");
  });

  it("reads recent times as relative, then yesterday, then days", () => {
    const now = new Date("2026-10-25T00:00:00Z");
    expect(formatAgo(new Date("2026-10-24T12:00:00Z"), now)).toBe("12 h ago");
    expect(formatAgo(new Date("2026-10-23T12:00:00Z"), now)).toBe("yesterday");
    expect(formatAgo(new Date("2026-10-21T12:00:00Z"), now)).toBe("3 days ago");
  });
});
