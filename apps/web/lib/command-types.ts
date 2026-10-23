import { COMMAND_TYPES, type BatchableCommand, type Command } from "@reelwalk/core";

/**
 * What `POST /api/reels/:id/commands` accepts (ADR 0068): every document
 * command the core defines, read from the core's own registry rather than
 * kept as a copy here. The copy had fallen behind the core (`cutaways`,
 * `updateClip`, `matchLook`, `autoSfx`, `setSfx`, `dropOnCut` were missing),
 * so agents hand-built what a command already did.
 */
export const ACCEPTED_COMMAND_TYPES: ReadonlySet<Command["type"]> = new Set<Command["type"]>(COMMAND_TYPES);

/** Commands an agent may send in one request; more is a sign of a loop. */
export const MAX_COMMANDS = 50;

export const isCommand = (item: unknown): item is Command =>
  typeof item === "object" && item !== null && typeof (item as { type?: unknown }).type === "string" && ACCEPTED_COMMAND_TYPES.has((item as Command).type);

/** A batch holds any command but another batch or a proposal (ADR 0048). */
export const inBatch = (command: Command): command is BatchableCommand => command.type !== "batch" && command.type !== "applyProposal";

export const COMMAND_SHAPE = `Send { command: { type, ... } } or { commands: [{ type, ... }] }; type is one of ${[...ACCEPTED_COMMAND_TYPES].join(", ")}.`;
