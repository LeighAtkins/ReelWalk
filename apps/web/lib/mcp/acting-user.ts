import { AsyncLocalStorage } from "node:async_hooks";
import type { User, Workspace, WorkspaceRole } from "@reelwalk/db";

/**
 * Who a connector request acts as (ADR 0077). The /mcp route checks the bearer
 * token, then runs the tool inside `runAsUser`; `getSessionUser` (lib/auth.ts)
 * answers with this person for everything called from there, so the upload,
 * AI and export code that already asks "who is signed in" works unchanged and
 * keeps its own checks (workspace scoping, plan limits, credits). The workspace
 * is the one the grant is bound to (ADR 0079), re-checked against the person's seats on every call. Nothing but
 * the /mcp route ever calls `runAsUser`, and it never reads a cookie.
 */
export type ActingUser = User & {
  /** The workspace the connection is bound to (ADR 0079): `workspaceId` and `workspace` below are that one, not the person's home. */
  workspace: Workspace;
  homeWorkspaceId: string;
  role: WorkspaceRole;
};

const store = new AsyncLocalStorage<ActingUser>();

export const actingUser = (): ActingUser | undefined => store.getStore();

export const runAsUser = <T>(user: ActingUser, work: () => Promise<T>): Promise<T> => store.run(user, work);
