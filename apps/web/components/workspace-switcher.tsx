import { switchWorkspace } from "@/app/workspace-actions";
import { listWorkspaces } from "@/lib/workspaces";
import { getSessionUser } from "@/lib/auth";

/**
 * The workspace in use and a way to change it (ADR 0079). Shown in the header of
 * the reels screen only for someone with more than one workspace, so a single-workspace
 * account sees nothing new. A plain <details>: no script, thumb-sized rows, each one a form that
 * posts to the `switchWorkspace` action (which checks the seat again).
 */
export async function WorkspaceSwitcher() {
  const user = await getSessionUser();
  if (!user) return null;
  const workspaces = await listWorkspaces(user, user.workspaceId);
  if (workspaces.length < 2) return null;
  const current = workspaces.find((workspace) => workspace.active) ?? workspaces[0];
  return (
    <details className="ws-switch" data-testid="workspace-switcher">
      <summary data-testid="workspace-current">{current.name}</summary>
      <ul className="ws-switch-list">
        {workspaces.map((workspace) => (
          <li key={workspace.id}>
            <form action={switchWorkspace}>
              <input type="hidden" name="workspaceId" value={workspace.id} />
              <button type="submit" className="ws-switch-row" aria-current={workspace.active ? "true" : undefined} disabled={workspace.active} data-testid="workspace-option">
                <span>{workspace.name}</span>
                {workspace.active ? <span className="muted small">in use</span> : null}
              </button>
            </form>
          </li>
        ))}
      </ul>
    </details>
  );
}
