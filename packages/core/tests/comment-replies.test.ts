import { describe, expect, it } from "vitest";
import { commentMentionsKeyword, commentsToAnswer, normalizeCommentKeyword } from "../src";

describe("normalizeCommentKeyword", () => {
  it("keeps one word, upper case", () => {
    expect(normalizeCommentKeyword(" reel ")).toBe("REEL");
    expect(normalizeCommentKeyword("“Guide”")).toBe("GUIDE");
    expect(normalizeCommentKeyword("viral2026")).toBe("VIRAL2026");
  });
  it("refuses phrases, symbols and empty input", () => {
    expect(normalizeCommentKeyword("free guide")).toBeNull();
    expect(normalizeCommentKeyword("reel!")).toBeNull();
    expect(normalizeCommentKeyword("   ")).toBeNull();
    expect(normalizeCommentKeyword("x".repeat(31))).toBeNull();
  });
});

describe("commentMentionsKeyword", () => {
  it("matches the word in any case and with punctuation or emoji around it", () => {
    for (const text of ["REEL", "reel!", "Reel please", "can I get the guide? reel 🙏", "@reelwalking REEL"]) {
      expect(commentMentionsKeyword(text, "REEL")).toBe(true);
    }
  });
  it("does not match inside other words", () => {
    for (const text of ["reels are great", "unreel", "@reelwalking love it", "real"]) {
      expect(commentMentionsKeyword(text, "REEL")).toBe(false);
    }
  });
});

describe("commentsToAnswer", () => {
  const now = new Date("2026-10-15T12:00:00Z");
  const triggers = [
    { id: "t1", keyword: "REEL" },
    { id: "t2", keyword: "GUIDE" },
  ];
  const comment = (id: string, text: string, hoursAgo = 1, username = "someone") => ({
    id,
    mediaId: "m1",
    text,
    username,
    timestamp: new Date(now.getTime() - hoursAgo * 3600_000).toISOString(),
  });

  it("answers each matching comment once, with the first trigger that matches", () => {
    const result = commentsToAnswer({
      comments: [comment("c1", "reel"), comment("c2", "nice house"), comment("c3", "guide please"), comment("c4", "reel and guide")],
      triggers,
      answered: new Set(["c3"]),
      ownUsername: "reelwalking",
      now,
    });
    expect(result.map((r) => [r.comment.id, r.trigger.id])).toEqual([
      ["c1", "t1"],
      ["c4", "t1"],
    ]);
  });

  it("skips the account's own comments and anything past the 7-day window", () => {
    const result = commentsToAnswer({
      comments: [comment("c1", "REEL", 1, "ReelWalking"), comment("c2", "REEL", 24 * 7 + 1), comment("c3", "REEL", 24 * 6)],
      triggers,
      answered: new Set(),
      ownUsername: "reelwalking",
      now,
    });
    expect(result.map((r) => r.comment.id)).toEqual(["c3"]);
  });
});
