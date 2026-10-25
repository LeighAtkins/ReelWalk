import {
  SHOT_LIST_JSON_SCHEMA,
  SHOT_LIST_SYSTEM_PROMPT,
  describeShootRequest,
  shotListSchema,
  standardShotList,
  type ShootRequest,
  type ShotList,
} from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { aiEditBlockedReason } from "@/lib/ai-edit";
import { AiError, aiModel, isFakeAi, structuredAnswer, usageCostUsd } from "@/lib/openai";
import { insideProviderGate } from "@/lib/provider-gate";

export type ShotListResult = ShotList & {
  /** "ai" when the model wrote it; "standard" when it is the house list (no model, allowance used up, or the answer did not fit). */
  source: "ai" | "standard";
  /** Why the standard list was used, in words for the agent. */
  why?: string;
};

/**
 * "Plan my shoot" (ADR 0063): asks the model for an ordered shot list in
 * strict JSON and validates it; counts as one AI request against the plan's
 * monthly allowance and is recorded like an Ask. Whenever the model cannot
 * be used, the agent still gets the standard list, and is told why.
 */
export async function planShoot(user: { id: string; workspaceId: string }, request: ShootRequest): Promise<ShotListResult> {
  const standard = (why: string): ShotListResult => ({ ...standardShotList(request), source: "standard", why });
  if (isFakeAi()) return standard("The model is not set up here, so this is the standard list.");
  const blocked = await aiEditBlockedReason(user.workspaceId);
  if (blocked) return standard(`${blocked.message} Here is the standard list.`);

  const ask = () =>
    structuredAnswer({
      workspaceId: user.workspaceId,
      instructions: SHOT_LIST_SYSTEM_PROMPT,
      input: describeShootRequest(request),
      schemaName: "shot_list",
      schema: SHOT_LIST_JSON_SCHEMA as unknown as Record<string, unknown>,
      maxOutputTokens: 2000,
    });
  let answer;
  try {
    answer = await ask().catch((error) => (error instanceof AiError && error.transient && !insideProviderGate() ? ask() : Promise.reject(error)));
  } catch (error) {
    if (!(error instanceof AiError)) throw error;
    console.error("shot list:", error.message);
    return standard("The model did not answer, so this is the standard list.");
  }
  const parsed = shotListSchema.safeParse(answer.json);
  await prisma.aiEdit.create({
    data: {
      workspaceId: user.workspaceId,
      userId: user.id,
      request: `Plan my shoot: ${describeShootRequest(request)}`.slice(0, 2000),
      note: parsed.success ? parsed.data.note : "The answer did not fit the shot list.",
      plan: (answer.json ?? {}) as object,
      applied: [],
      skipped: [],
      model: answer.model,
      inputTokens: answer.usage.inputTokens,
      cachedTokens: answer.usage.cachedTokens,
      outputTokens: answer.usage.outputTokens,
    },
  });
  console.log(`shot list: ${answer.model}, ${answer.usage.inputTokens} in, ${answer.usage.outputTokens} out, $${usageCostUsd(aiModel(), answer.usage).toFixed(4)}, ${parsed.success ? parsed.data.shots.length : 0} shots`);
  if (!parsed.success) {
    console.error("shot list: answer did not fit the schema", parsed.error.issues.slice(0, 3));
    return standard("The model's answer did not make sense, so this is the standard list.");
  }
  return { ...parsed.data, source: "ai" };
}
