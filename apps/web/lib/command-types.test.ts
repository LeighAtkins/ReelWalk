import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCEPTED_COMMAND_TYPES, COMMAND_SHAPE, inBatch, isCommand } from "./command-types";

/** The `type` literal of every member of the core's `Command` union, read from its source so the registry is checked against the definition, not against itself. */
function commandTypesInCoreSource(): string[] {
  const source = readFileSync(fileURLToPath(new URL("../../../packages/core/src/commands.ts", import.meta.url)), "utf8");
  const union = source.slice(source.indexOf("export type Command ="), source.indexOf("export type BatchableCommand"));
  return [...union.matchAll(/\|\s*\(?\{\s*type:\s*"([A-Za-z]+)"/g)].map((match) => match[1]);
}

describe("the commands route's registry", () => {
  it("accepts every document command the core defines (a missing one made agents hand-build J-cuts, ADR 0069)", () => {
    const defined = commandTypesInCoreSource();
    expect(defined.length).toBeGreaterThan(20);
    const missing = defined.filter((type) => !ACCEPTED_COMMAND_TYPES.has(type as never));
    expect(missing).toEqual([]);
    const extra = [...ACCEPTED_COMMAND_TYPES].filter((type) => !defined.includes(type));
    expect(extra).toEqual([]);
  });
  it("lists the commands that were missing from the hand-kept copy", () => {
    for (const type of ["cutaways", "updateClip", "matchLook", "autoSfx", "setSfx", "dropOnCut"]) expect(ACCEPTED_COMMAND_TYPES.has(type as never)).toBe(true);
    expect(isCommand({ type: "cutaways", everyMs: 5000 })).toBe(true);
    expect(isCommand({ type: "retimeTexts" })).toBe(false);
    expect(isCommand({ type: 3 })).toBe(false);
    expect(COMMAND_SHAPE).toContain("cutaways");
  });
  it("keeps a batch and a proposal out of a batch", () => {
    expect(inBatch({ type: "cutaways", everyMs: 5000 })).toBe(true);
    expect(inBatch({ type: "batch", commands: [] })).toBe(false);
    expect(inBatch({ type: "applyProposal", baseGeneration: 1, proposal: {} })).toBe(false);
  });
});
