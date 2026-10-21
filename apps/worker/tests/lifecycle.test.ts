import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/library/tools";
import { AttemptStopped, createAttemptScope, descendantsOf, linkAbort, listProcesses, runAttempt } from "../src/lifecycle";

const hang = [process.execPath, ["-e", "setInterval(() => {}, 1000)"]] as const;
const stop = (why: "deadline" | "shutdown" = "deadline") => new AttemptStopped(`stopped: ${why}`, why);

describe("run", () => {
  it("kills the child when its attempt is aborted, and settles with the stop reason once it has exited", async () => {
    const scope = createAttemptScope({ graceMs: 1000, log: () => {} });
    const running = run(...hang, { scope });
    // Registered with the scope while it runs.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scope.held()).toHaveLength(1);
    scope.abort(stop());
    await expect(running).rejects.toMatchObject({ why: "deadline" });
    expect(scope.held()).toEqual([]);
  });

  it("kills the child on its own timeout through the same path", async () => {
    await expect(run(...hang, { timeoutMs: 100 })).rejects.toThrow(/did not finish within/);
  });

  it("refuses to start once the attempt is stopped", async () => {
    const scope = createAttemptScope({ log: () => {} });
    scope.abort(stop());
    await expect(run(process.execPath, ["-e", "1"], { scope })).rejects.toBeInstanceOf(AttemptStopped);
  });

  it("returns output as before when nothing stops it", async () => {
    const { stdout } = await run(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(stdout).toBe("ok");
  });
});

describe("runAttempt", () => {
  it("waits out the grace for work that ignores the abort, then releases and throws the stop reason", async () => {
    const released: string[] = [];
    const scope = createAttemptScope({ graceMs: 100, log: () => {} });
    scope.own("first", () => { released.push("first"); });
    scope.own("second", () => { released.push("second"); });
    const result = runAttempt(scope, () => new Promise(() => undefined));
    const started = Date.now();
    scope.abort(stop("shutdown"));
    await expect(result).rejects.toMatchObject({ why: "shutdown" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    // Newest first.
    expect(released).toEqual(["second", "first"]);
  });

  it("does not let a release that hangs hold the attempt past the grace", async () => {
    const scope = createAttemptScope({ graceMs: 50, log: () => {} });
    scope.own("stuck", () => new Promise(() => undefined));
    await expect(runAttempt(scope, async () => "done")).resolves.toBe("done");
  });

  it("releases a resource registered after the scope closed straight away", async () => {
    const scope = createAttemptScope({ log: () => {} });
    await scope.close();
    let released = false;
    scope.own("late", () => { released = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(true);
  });

  it("links an outside signal such as SIGTERM", () => {
    const scope = createAttemptScope({ log: () => {} });
    const source = new AbortController();
    const unlink = linkAbort(source.signal, scope, () => stop("shutdown"));
    source.abort();
    expect(scope.signal.aborted).toBe(true);
    expect((scope.signal.reason as AttemptStopped).why).toBe("shutdown");
    unlink();
  });
});

describe("finding Remotion's processes", () => {
  it("reads a /proc tree and walks a process's descendants", async () => {
    const proc = await mkdtemp(path.join(os.tmpdir(), "proc-"));
    const add = async (pid: number, ppid: number, comm: string, argv0: string) => {
      await mkdir(path.join(proc, String(pid)));
      await writeFile(path.join(proc, String(pid), "stat"), `${pid} (${comm}) S ${ppid} 1 1 0`);
      await writeFile(path.join(proc, String(pid), "cmdline"), `${argv0}\0--flag\0`);
    };
    await add(10, 1, "node", "node");
    await add(11, 10, "headless_shell", "/x/chrome-headless-shell");
    await add(12, 11, "chrome (render)", "/x/chrome-headless-shell");
    await add(13, 10, "ffmpeg", "ffmpeg");
    await add(20, 1, "other", "other");

    const processes = await listProcesses(proc);
    expect(processes.find((p) => p.pid === 12)).toMatchObject({ ppid: 11, command: "/x/chrome-headless-shell" });
    expect(descendantsOf(10, processes).map((p) => p.pid)).toEqual([11, 13, 12]);
  });

  it("finds nothing where there is no /proc", async () => {
    expect(await listProcesses(path.join(os.tmpdir(), "no-such-proc"))).toEqual([]);
  });
});
