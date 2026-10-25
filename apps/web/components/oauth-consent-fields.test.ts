import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SCOPE_LABELS, type Scope } from "@/lib/mcp/scopes";
import { OAuthConsentFields } from "./oauth-consent-fields";

const ALL: Scope[] = ["reels:read", "reels:write", "exports", "ai:generate"];
const html = (props: { workspaces: { id: string; name: string; ai: "on" | "off" }[]; activeId: string; requested?: Scope[] }) =>
  renderToStaticMarkup(createElement(OAuthConsentFields, { requested: ALL, labels: SCOPE_LABELS, ...props }));

const inputs = (markup: string) => [...markup.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
const scopeBox = (markup: string, scope: Scope) => inputs(markup).find((tag) => tag.includes('name="scope"') && tag.includes(`value="${scope}"`));

describe("the consent screen's fields (ADR 0079)", () => {
  const one = [{ id: "ws1", name: "ReelWalk", ai: "on" as const }];
  const two = [...one, { id: "ws2", name: "Last Mile", ai: "off" as const }];

  it("leaves ai:generate unticked by default even though the app asked for it, and ticks the rest", () => {
    const markup = html({ workspaces: one, activeId: "ws1" });
    for (const scope of ["reels:read", "reels:write", "exports"] as const) expect(scopeBox(markup, scope)).toContain("checked");
    expect(scopeBox(markup, "ai:generate")).toBeDefined();
    expect(scopeBox(markup, "ai:generate")).not.toContain("checked");
  });

  it("does not offer ai:generate at all when the (only) workspace has AI off", () => {
    const markup = html({ workspaces: [{ id: "ws2", name: "Last Mile", ai: "off" }], activeId: "ws2" });
    expect(scopeBox(markup, "ai:generate")).toBeUndefined();
    expect(markup).toContain("AI generation is turned off for Last Mile");
    expect(scopeBox(markup, "reels:read")).toBeDefined();
  });

  it("starts on the active workspace: Last Mile active with AI off hides ai:generate, the home workspace shows it", () => {
    expect(scopeBox(html({ workspaces: two, activeId: "ws2" }), "ai:generate")).toBeUndefined();
    expect(scopeBox(html({ workspaces: two, activeId: "ws1" }), "ai:generate")).toBeDefined();
  });

  it("with several workspaces asks which one, defaulting to the active one", () => {
    const markup = html({ workspaces: two, activeId: "ws2" });
    expect(markup).toContain("Which workspace should it work in?");
    const radios = inputs(markup).filter((tag) => tag.includes('type="radio"'));
    expect(radios).toHaveLength(2);
    expect(radios.find((tag) => tag.includes('value="ws2"'))).toContain("checked");
    expect(radios.find((tag) => tag.includes('value="ws1"'))).not.toContain("checked");
    expect(markup).toContain("disconnect the app and connect again");
  });

  it("with one workspace just sends it as a hidden field", () => {
    const markup = html({ workspaces: one, activeId: "ws1" });
    expect(inputs(markup).some((tag) => tag.includes('type="hidden"') && tag.includes('name="workspace"') && tag.includes('value="ws1"'))).toBe(true);
    expect(markup).not.toContain("Which workspace");
  });

  it("an app that did not ask for ai:generate is not offered it", () => {
    expect(scopeBox(html({ workspaces: one, activeId: "ws1", requested: ["reels:read"] }), "ai:generate")).toBeUndefined();
  });
});
