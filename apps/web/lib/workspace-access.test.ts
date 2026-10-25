import { describe, expect, it } from "vitest";
import { ACTIVE_WORKSPACE_COOKIE, canManage, hasSeat, readActiveWorkspace, resolveSeat, seatsFor, signActiveWorkspace, type Seat } from "./workspace-access";

const SESSION = "session-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER_SESSION = "session-token-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HOME = "ws_home";
const LAST_MILE = "ws_lastmile";

describe("seats", () => {
  it("puts the home workspace first and counts it as the person's even with no member row", () => {
    expect(seatsFor(HOME, [])).toEqual([{ workspaceId: HOME, role: "OWNER" }]);
    expect(seatsFor(HOME, [{ workspaceId: LAST_MILE, role: "OWNER" }, { workspaceId: HOME, role: "OWNER" }])).toEqual([
      { workspaceId: HOME, role: "OWNER" },
      { workspaceId: LAST_MILE, role: "OWNER" },
    ]);
  });

  it("keeps the role a row records, and lists each workspace once", () => {
    const seats = seatsFor(HOME, [{ workspaceId: LAST_MILE, role: "EDITOR" }, { workspaceId: LAST_MILE, role: "OWNER" }]);
    expect(seats).toEqual([{ workspaceId: HOME, role: "OWNER" }, { workspaceId: LAST_MILE, role: "EDITOR" }]);
  });

  it("hasSeat says whether the person may act in a workspace", () => {
    const rows: Seat[] = [{ workspaceId: LAST_MILE, role: "OWNER" }];
    expect(hasSeat(HOME, rows, HOME)).toBe(true);
    expect(hasSeat(HOME, rows, LAST_MILE)).toBe(true);
    expect(hasSeat(HOME, rows, "ws_someone_else")).toBe(false);
  });

  it("only owners manage a workspace", () => {
    expect(canManage("OWNER")).toBe(true);
    expect(canManage("EDITOR")).toBe(false);
  });
});

describe("the signed workspace cookie", () => {
  it("reads back the workspace it was signed for", () => {
    const value = signActiveWorkspace(SESSION, "u1", LAST_MILE);
    expect(readActiveWorkspace(value, SESSION, "u1")).toBe(LAST_MILE);
  });

  it("is refused when tampered with, signed for another session, or signed for another person", () => {
    const value = signActiveWorkspace(SESSION, "u1", LAST_MILE);
    expect(readActiveWorkspace(value.replace(LAST_MILE, "ws_someone_else"), SESSION, "u1")).toBeNull();
    expect(readActiveWorkspace(`${LAST_MILE}.${"A".repeat(43)}`, SESSION, "u1")).toBeNull();
    expect(readActiveWorkspace(value, OTHER_SESSION, "u1")).toBeNull();
    expect(readActiveWorkspace(value, SESSION, "u2")).toBeNull();
  });

  it("is refused when empty or malformed", () => {
    for (const bad of [undefined, "", "nodot", ".", `${LAST_MILE}.`, `.${"A".repeat(43)}`]) expect(readActiveWorkspace(bad, SESSION, "u1")).toBeNull();
  });

  it("has a stable cookie name", () => {
    expect(ACTIVE_WORKSPACE_COOKIE).toBe("rw_workspace");
  });
});

describe("which workspace a request acts in", () => {
  const seats = seatsFor(HOME, [{ workspaceId: LAST_MILE, role: "OWNER" }]);
  const resolve = (cookieValue: string | undefined, over: Partial<Parameters<typeof resolveSeat>[0]> = {}) =>
    resolveSeat({ homeWorkspaceId: HOME, seats, cookieValue, sessionToken: SESSION, userId: "u1", ...over });

  it("falls back to the home workspace with no cookie", () => {
    expect(resolve(undefined)).toEqual({ workspaceId: HOME, role: "OWNER" });
  });

  it("follows a valid cookie to another workspace the person has a seat in", () => {
    expect(resolve(signActiveWorkspace(SESSION, "u1", LAST_MILE))).toEqual({ workspaceId: LAST_MILE, role: "OWNER" });
  });

  it("ignores a forged, replayed or garbled cookie", () => {
    expect(resolve("garbage")).toEqual({ workspaceId: HOME, role: "OWNER" });
    expect(resolve(signActiveWorkspace(OTHER_SESSION, "u1", LAST_MILE))).toEqual({ workspaceId: HOME, role: "OWNER" });
    expect(resolve(signActiveWorkspace(SESSION, "u2", LAST_MILE))).toEqual({ workspaceId: HOME, role: "OWNER" });
  });

  it("never reaches a workspace the person has no seat in, even with a perfectly signed cookie", () => {
    // A seat removed after the cookie was set, or a workspace id from someone else's account.
    const removed = signActiveWorkspace(SESSION, "u1", "ws_someone_else");
    expect(resolve(removed)).toEqual({ workspaceId: HOME, role: "OWNER" });
    expect(resolve(signActiveWorkspace(SESSION, "u1", LAST_MILE), { seats: seatsFor(HOME, []) })).toEqual({ workspaceId: HOME, role: "OWNER" });
  });

  it("carries the role of the seat it lands on", () => {
    const withEditor = seatsFor(HOME, [{ workspaceId: LAST_MILE, role: "EDITOR" }]);
    expect(resolve(signActiveWorkspace(SESSION, "u1", LAST_MILE), { seats: withEditor }).role).toBe("EDITOR");
  });
});
