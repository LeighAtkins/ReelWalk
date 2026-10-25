import { prisma } from "@reelwalk/db";

/**
 * The per-workspace AI switch (ADR 0079). `Workspace.aiGeneration` is "on"
 * (the default) or "off". Off means the workspace never makes an AI request
 * and never spends credits: AI video (Veo, voiced takes), drafts, presenters'
 * takes, the Ask and director model calls, the surface finder's vision call,
 * script and idea writers, room labels. Every web path to a provider checks
 * it server-side: `createAiGeneration` for video, `structuredAnswer` for every
 * model call (its `workspaceId` option is required, so a new caller cannot
 * skip it), and the routes check first to answer with a clear message
 * before doing any other work. The editor also hides the AI buttons.
 */

export type AiSwitch = "on" | "off";

export const AI_OFF_MESSAGE = "AI generation is turned off for this workspace. An owner can turn it on under Account, Workspaces.";
export const AI_OFF_CODE = "ai_off";

export class AiOffError extends Error {
  readonly code = AI_OFF_CODE;
  constructor(message = AI_OFF_MESSAGE) {
    super(message);
    this.name = "AiOffError";
  }
}

export const aiSwitchOf = (value: string | null | undefined): AiSwitch => (value === "off" ? "off" : "on");

/** True when AI generation is off for the workspace. A workspace that cannot be found counts as off: nothing is spent for a stranger. */
export async function aiIsOff(workspaceId: string): Promise<boolean> {
  const row = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { aiGeneration: true } });
  return !row || aiSwitchOf(row.aiGeneration) === "off";
}

/** Throws `AiOffError` when AI generation is off for the workspace. */
export async function assertAiOn(workspaceId: string): Promise<void> {
  if (await aiIsOff(workspaceId)) throw new AiOffError();
}

/** The body of the refusal an HTTP route sends (403), or null when AI is on. */
export async function aiOffResponse(workspaceId: string): Promise<Response | null> {
  return (await aiIsOff(workspaceId)) ? Response.json({ ok: false, error: AI_OFF_MESSAGE, message: AI_OFF_MESSAGE, code: AI_OFF_CODE }, { status: 403 }) : null;
}
