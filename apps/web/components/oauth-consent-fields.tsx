"use client";

import { useState } from "react";
import { consentChoices } from "@/lib/mcp/consent";
import type { Scope } from "@/lib/mcp/scopes";

type Workspace = { id: string; name: string; ai: "on" | "off" };
type Labels = Record<Scope, { title: string; detail: string }>;

/**
 * The workspace picker and scope boxes of the connector's consent screen
 * (ADR 0079). The connection acts on the workspace picked here; the active one
 * is the default. `ai:generate` is never ticked by default, and a workspace
 * with AI off is not offered it at all (the decision route enforces the same
 * rule server-side, so hiding it here is a courtesy, not the gate).
 */
export function OAuthConsentFields({ workspaces, activeId, requested, labels }: { workspaces: Workspace[]; activeId: string; requested: Scope[]; labels: Labels }) {
  const [selected, setSelected] = useState(workspaces.some((workspace) => workspace.id === activeId) ? activeId : workspaces[0]?.id);
  const chosen = workspaces.find((workspace) => workspace.id === selected);
  const choices = consentChoices(requested, chosen?.ai !== "off");
  return (
    <>
      {workspaces.length > 1 ? (
        <fieldset className="consent-workspaces" data-testid="oauth-workspaces">
          <legend>Which workspace should it work in?</legend>
          {workspaces.map((workspace) => (
            <label className="check" key={workspace.id}>
              <input type="radio" name="workspace" value={workspace.id} checked={workspace.id === selected} onChange={() => setSelected(workspace.id)} />
              <span>
                <strong>{workspace.name}</strong>
                {workspace.ai === "off" ? <span className="muted small"> · AI generation is off</span> : null}
              </span>
            </label>
          ))}
          <p className="muted small">To change it later, disconnect the app and connect again.</p>
        </fieldset>
      ) : (
        <input type="hidden" name="workspace" value={chosen?.id ?? ""} />
      )}
      {choices.map(({ scope, offered, checked }) =>
        offered ? (
          <label className="check" key={`${chosen?.id}:${scope}`}>
            <input type="checkbox" name="scope" value={scope} defaultChecked={checked} />
            <span>
              <strong>{labels[scope].title}</strong>
              <br />
              <span className="muted small">{labels[scope].detail}</span>
              {!checked ? (
                <>
                  <br />
                  <span className="muted small">Off unless you tick it.</span>
                </>
              ) : null}
            </span>
          </label>
        ) : (
          <p className="muted small" key={scope} data-testid="oauth-ai-off">
            AI generation is turned off for {chosen?.name}, so this app can&apos;t spend AI credits there.
          </p>
        ),
      )}
    </>
  );
}
