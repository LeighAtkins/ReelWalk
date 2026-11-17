import { beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => void)[], deps: [] as unknown[][] }));
vi.mock("react", () => ({
  useState: (initial: unknown) => { const i = hooks.index++; if (!(i in hooks.values)) hooks.values[i] = initial; return [hooks.values[i], (v: unknown) => { hooks.values[i] = v; }]; },
  useRef: (initial: unknown) => { const i = hooks.index++; return hooks.values[i] ??= { current: initial }; },
  useEffect: (fn: () => void, deps: unknown[]) => { const i = hooks.index++; if (!hooks.deps[i] || deps.some((v, j) => v !== hooks.deps[i][j])) { hooks.deps[i] = deps; hooks.effects.push(fn); } },
}));
vi.mock("./shot-keyframe-panel", () => ({ ShotKeyframePanel: () => null }));
import { FurnitureStagePanel } from "./furniture-stage-panel";
type Node = { props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const n = value as Node; return [n, ...nodes(n.props?.children)];
}
const stage = { version: 1, style: "warm-minimal", instructions: "", region: { x: 0, y: 0, width: 1, height: 1 } };
let props: Parameters<typeof FurnitureStagePanel>[0];
function render() { hooks.index = 0; let tree = FurnitureStagePanel(props); const effects = hooks.effects.splice(0); effects.forEach(f => f()); hooks.index = 0; tree = FurnitureStagePanel(props); return nodes(tree); }
function find(key: string, value: unknown) { return render().find(n => n.props?.[key] === value)!.props!; }
function click(label: string) { (find("children", label).onClick as () => void)(); }
async function settle() { await new Promise(resolve => setTimeout(resolve, 0)); }
beforeEach(() => {
  hooks.values = []; hooks.deps = []; hooks.effects = [];
  props = { photos: [], source: "asset:A", stage, disabled: false, recoveryKey: "card1", onSource: vi.fn(), onChange: vi.fn(), onUse: vi.fn(), onOriginal: vi.fn(), onAssets: vi.fn(), onBalance: vi.fn(), onBlocked: vi.fn() } as unknown as typeof props;
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, blob: async () => new Blob(["jpeg"]), headers: new Headers({ "X-Preview-Hash": "a".repeat(64) }) })));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview"); vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
function begin() { const panel = render().find(n => typeof n.props?.onAdjust === "function")!; (panel.props!.onAdjust as (j: unknown) => void)({ id: "job", input: { source: { assetId: "A" }, furnitureStage: stage } }); render(); }
it("requires the current preview load and disables use on error", async () => {
  begin(); click("Preview adjusted area"); await settle();
  expect(find("children", "Use adjusted concept").disabled).toBe(true);
  const image = find("alt", "Adjusted concept preview"); (image.onError as () => void)();
  expect(find("children", "Use adjusted concept").disabled).toBe(true);
  (image.onLoad as () => void)(); expect(find("children", "Use adjusted concept").disabled).toBe(false);
  props = { ...props, stage: { ...props.stage, instructions: "changed" } }; render();
  (image.onLoad as () => void)(); expect(find("children", "Use adjusted concept").disabled).toBe(true);
});
it("resets adjustment when original source changes", () => {
  begin(); props = { ...props, source: "asset:B" };
  expect(render().some(n => n.props?.children === "Preview adjusted area")).toBe(false);
});
it("ignores a pending save after a card change", async () => {
  begin(); click("Preview adjusted area"); await settle();
  (find("alt", "Adjusted concept preview").onLoad as () => void)();
  let resolve!: (value: unknown) => void;
  vi.mocked(fetch).mockImplementationOnce(() => new Promise(r => { resolve = r as typeof resolve; }));
  click("Use adjusted concept"); props = { ...props, recoveryKey: "card2" }; render();
  resolve({ ok: true, json: async () => ({ asset: {}, input: { furnitureStage: stage }, lineage: { hash: "hash" } }) }); await settle();
  expect(props.onUse).not.toHaveBeenCalled(); expect(props.onAssets).not.toHaveBeenCalled();
});

it("keeps the saved job and adjusted region available after save and reopening", async () => {
  props = { ...props, photos: [{ id: "A", kind: "IMAGE", url: "original", isPano: false }] as typeof props.photos,
    onChange: vi.fn(value => { props = { ...props, stage: value }; }),
    onAssets: vi.fn(assets => { props = { ...props, photos: [...props.photos, ...assets] }; }),
    onUse: vi.fn((asset, _input, hash) => { props = { ...props, selectedAssetId: asset.id, derivativeHash: hash }; }) };
  begin();
  const adjusted = { ...props.stage, region: { x: 0, y: 0.5, width: 0.48, height: 0.2 } };
  props = { ...props, stage: adjusted }; render();
  click("Preview adjusted area"); await settle();
  (find("alt", "Adjusted concept preview").onLoad as () => void)();
  const hash = "a".repeat(64);
  vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
    asset: { id: "derivative", kind: "IMAGE", aiKeyframe: { jobId: "job", sourceAssetId: "A", outputHash: hash } },
    input: { source: { assetId: "A" }, furnitureStage: adjusted }, lineage: { hash },
  }) } as Response);
  click("Use adjusted concept"); await settle();
  expect(props.onUse).toHaveBeenCalledTimes(1);
  let panel = render().find(n => typeof n.props?.onAdjust === "function")!.props!;
  expect(panel.selectedDerivativeJobId).toBe("job");
  hooks.values = []; hooks.deps = []; hooks.effects = [];
  panel = render().find(n => typeof n.props?.onAdjust === "function")!.props!;
  expect(panel.selectedDerivativeJobId).toBe("job");
  (panel.onAdjust as (job: unknown) => void)({ id: "job", input: { source: { assetId: "A" }, furnitureStage: stage } });
  expect(props.stage.region).toEqual(adjusted.region);
  expect(render().some(n => n.props?.children === "Preview adjusted area")).toBe(true);
  props = { ...props, source: "asset:B" }; render();
  panel = render().find(n => typeof n.props?.onAdjust === "function")!.props!;
  expect(panel.selectedDerivativeJobId).toBeUndefined();
});
