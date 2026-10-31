# 0101 — Directed AI shots through the connector

Date: 2026-10-31

## Context

The connector's `generate_ai_shot` (ADR 0077) took a prompt, one reference photo and a length. The editor's own route
(`POST /api/ai/generations`) takes much more:
- a starting and ending frame;
- a presenter composed into them (ADR 0036, 0056);
- a spoken line and its voice (ADR 0038, 0100);
- the draft tier and "Make it final" (ADR 0076).

So a presenter take could only be made in the editor, not by an assistant working through the connector.

## Decision

`generate_ai_shot` takes the editor's fields: `shot`, `quality` and `finalOf`.

- **Same validation.** `shot` is checked with the editor's own `aiShotSchema` before anything is quoted. A shot the
  editor would refuse is refused with the same message.
- **Same path.** The start goes through `createAiGeneration`, so its checks apply unchanged:
  - frames from the workspace's own media;
  - the presenter kit, or a generated reference only with `allowGeneratedReference`;
  - the voice switch;
  - the credit reservation and the queue.
- **Same prices.** A draft is 1 credit. A spoken line adds 1. A final made from a draft costs the full price less the
  draft's credit, read from the draft's own row. The draft must be finished and in this workspace.
- **Unchanged otherwise:** quote first, then confirm with `confirmCredits` equal to the quote; `requestId` for retries;
  the hourly limit; the `ai:generate` scope. Nothing here posts or exports.

## Verified

`lib/mcp/tools.test.ts`:
- a directed draft is quoted at 1 credit and started with its composed presenter, line and voice;
- a voiced full take is quoted at 2 credits (4 s) or 3 (8 s);
- a final from a draft is priced from the draft's row and started with `finalOf` only;
- an invalid shot, a final of a take that is not a draft, and a missing draft are refused with nothing spent.
