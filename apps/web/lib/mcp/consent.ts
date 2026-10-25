import type { Scope } from "./scopes";

/**
 * What the consent screen offers and what it may grant (ADR 0079). Pure, so
 * the page, the decision route and the tests share one rule:
 *
 * - `ai:generate` spends the workspace's credits, so it is **never ticked by
 *   default**, even when the app asked for it; the person ticks it on purpose.
 * - A workspace with AI generation off is not offered `ai:generate` at all, and
 *   it is never granted for it, whatever a forged form says.
 */

export type ConsentChoice = { scope: Scope; offered: boolean; checked: boolean };

export const consentChoices = (requested: readonly Scope[], aiOn: boolean): ConsentChoice[] =>
  requested.map((scope) => ({ scope, offered: scope !== "ai:generate" || aiOn, checked: scope !== "ai:generate" }));

/** The scopes that may be granted: ticked, asked for, and allowed in this workspace. */
export const grantableScopes = (ticked: readonly Scope[], requested: readonly Scope[], aiOn: boolean): Scope[] =>
  [...new Set(ticked)].filter((scope) => requested.includes(scope) && (scope !== "ai:generate" || aiOn));
