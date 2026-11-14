import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ $transaction: vi.fn(), $queryRaw: vi.fn(), workspace: { deleteMany: vi.fn() }, user: { count: vi.fn(), deleteMany: vi.fn() }, workspaceMember: { count: vi.fn() }, mediaAsset: { findMany: vi.fn() }, renderOutput: { findMany: vi.fn() }, keys: vi.fn(), remove: vi.fn(), destroy: vi.fn() }));
vi.mock("@reelwalk/db", () => ({ prisma: mocks, keyframeStorageTransaction: (_db: unknown, _ids: string[], callback: unknown) => mocks.$transaction(callback), DEFAULT_USER_EMAIL: "demo", hashPassword: vi.fn(), verifyPassword: async () => true, renderArtifactKeys: async () => [] }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw Error(`redirect:${to}`); } }));
vi.mock("@/lib/auth", () => ({ createSession: vi.fn(), destroySession: mocks.destroy }));
vi.mock("@/lib/workspace", () => ({ getCurrentUser: async () => ({ id: "user", homeWorkspaceId: "owned", passwordHash: "hash" }) }));
vi.mock("@/lib/workspaces", () => ({ loadSeats: async () => [{ workspaceId: "owned" }, { workspaceId: "still-used" }] }));
vi.mock("@/lib/funnel", () => ({ recordFunnelEvent: vi.fn() }));
vi.mock("@/lib/throttle", () => ({ overLimit: async () => false, countAttempt: vi.fn(), clearAttempts: vi.fn(), clientIp: vi.fn(), MINUTE: 60000 }));
vi.mock("@/lib/storage", () => ({ keyframeObjectKeys: mocks.keys, deleteObjects: mocks.remove }));
import { deleteAccount } from "../app/auth-actions";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.$transaction.mockImplementation(async fn => fn(mocks));
  mocks.user.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1); mocks.workspaceMember.count.mockResolvedValue(0);
  mocks.mediaAsset.findMany.mockResolvedValue([]); mocks.renderOutput.findMany.mockResolvedValue([]);
});
const form = () => { const data = new FormData(); data.set("password", "password"); data.set("confirm", "yes"); return data; };
describe("account deletion with retained keyframes", () => {
  it("inventories files before cascade and deletes them only for departing workspaces", async () => {
    const files = ["private/keyframes/owned/source.png", "private/keyframes/owned/request.json", "private/keyframes/owned/receipts/job.json", "private/keyframes/owned/candidates/unused.jpg"];
    mocks.keys.mockImplementation(async () => { expect(mocks.$queryRaw).toHaveBeenCalledOnce(); expect(mocks.workspace.deleteMany).not.toHaveBeenCalled(); return files; });
    mocks.remove.mockImplementation(async keys => { if (keys.length) expect(mocks.workspace.deleteMany).not.toHaveBeenCalled(); });
    await expect(deleteAccount(form())).rejects.toThrow("redirect:/login?deleted=1");
    expect(mocks.keys).toHaveBeenCalledWith(["owned"]);
    expect(mocks.workspace.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["owned"] } } });
    expect(mocks.remove).toHaveBeenCalledWith(files); expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it("does not cascade away recovery records when deleting private keyframe files fails", async () => {
    mocks.keys.mockResolvedValue(["private/keyframes/owned/receipt.json"]);
    mocks.remove.mockRejectedValue(Error("partial deletion failure"));
    await expect(deleteAccount(form())).rejects.toThrow("partial deletion failure");
    expect(mocks.workspace.deleteMany).not.toHaveBeenCalled(); expect(mocks.user.deleteMany).not.toHaveBeenCalled();
  });
  it("retains the account and its artifact index if enumeration fails", async () => {
    mocks.keys.mockRejectedValue(Error("storage unavailable"));
    await expect(deleteAccount(form())).rejects.toThrow("storage unavailable");
    expect(mocks.workspace.deleteMany).not.toHaveBeenCalled(); expect(mocks.user.deleteMany).not.toHaveBeenCalled(); expect(mocks.remove).not.toHaveBeenCalled();
  });
});
