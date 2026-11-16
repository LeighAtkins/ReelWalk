import { beforeEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";
import type { CampaignFacts } from "@reelwalk/core";

const state = vi.hoisted(() => ({ setters: [] as ReturnType<typeof vi.fn>[] }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => {
    const setter = vi.fn(); state.setters.push(setter);
    return [typeof initial === "function" ? initial() : initial, setter];
  },
}));
import { CampaignFactsForm } from "./campaign-facts-form";

beforeEach(() => { state.setters = []; });
const initial: CampaignFacts = { address: "Demo house", price: "Example price", beds: "", baths: "", area: "", contact: "Demo", openHome: "Demo Saturday", disclosure: "AI concept" };
function form(action: (data: FormData) => Promise<void | { error: string }>) {
  return CampaignFactsForm({ initial, action, requestKey: "same-saved-request", sources: [{ id: "source", title: "Source", revision: 1 }] });
}
it.each(["/campaigns/new", "/campaigns/existing?updated=1"])("propagates a successful campaign redirect to %s without a false connection alert", async url => {
  let controlFlow: unknown;
  try { redirect(url); } catch (error) { controlFlow = error; }
  const element = form(async () => { throw controlFlow; });
  await expect(element.props.action(new FormData())).rejects.toBe(controlFlow);
  expect(state.setters[7]).not.toHaveBeenCalled();
  expect(state.setters[6]).toHaveBeenCalledWith(false);
});
it("keeps real network failures retryable without clearing facts or the saved request", async () => {
  const element = form(async () => { throw new TypeError("Failed to fetch"); });
  await element.props.action(new FormData());
  expect(state.setters[7]).toHaveBeenCalledWith("The connection failed. Your details are kept here; retry the same request.");
  for (const setter of state.setters.slice(0, 6)) expect(setter).not.toHaveBeenCalled();
  expect(state.setters[6]).toHaveBeenCalledWith(false);
});
it("preserves an ordinary server validation error", async () => {
  await form(async () => ({ error: "Source changed; review again." })).props.action(new FormData());
  expect(state.setters[7]).toHaveBeenCalledWith("Source changed; review again.");
});
