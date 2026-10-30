import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// infra/local-worker/start.sh's two risky steps, run in bash with docker and aws stood in for (ADR 0094):
// clearing a heavy lock a dead worker container left, and making the worker's AWS key.
const script = path.resolve(__dirname, "../../../infra/local-worker/start.sh").replaceAll("\\", "/");
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

let tmp: string;
const slash = (p: string) => p.replaceAll("\\", "/");
beforeEach(() => { tmp = mkdtempSync(path.join(os.tmpdir(), "local-worker-")); });
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * Runs `body` in bash, sandboxed: the heavy lock's folder, the secrets folder and the working directory are this
 * test's temp dir, and `aws` is a stub, before start.sh is even sourced. So even a script that ran its main flow
 * on being sourced (start.sh before this PR did) could never touch the PC's real C:\dev\lm\.heavy.lock, ~/.reelwalk
 * or AWS. (It once did, through a test like this one: the real lock was replaced by a fake holder.)
 */
function bash(body: string, env: Record<string, string> = {}) {
  const sandbox = { HEAVY_LOCK_PARENT: slash(tmp), REELWALK_SECRETS: slash(path.join(tmp, "secrets")), AWS_CLI: "false", AWS_PROFILE_ADMIN: "none" };
  const run = spawnSync("bash", ["-c", body], { cwd: tmp, encoding: "utf8", env: { ...process.env, ...sandbox, ...env } });
  return { out: `${run.stdout}${run.stderr}`, status: run.status };
}

describe.skipIf(!hasBash)("start.sh: clearing a dead worker's heavy lock", () => {
  const C = "c".repeat(64);
  const ours = `reelwalk-local-worker 2026-10-30T00:00:00.000Z render job container=${C} pid=7 start=99 boot=k1 #t`;
  const lockDir = () => path.join(tmp, ".heavy.lock");
  const holding = (holder: string) => { mkdirSync(lockDir()); writeFileSync(path.join(lockDir(), "owner.txt"), `${holder}\n`); };
  /** Runs clear_dead_lock with `docker inspect` answering `says` ("false", "true", "gone", "error", or "race"). */
  const clear = (says: string) => bash(`
    docker() {
      [ "$1" = inspect ] || { echo "docker $1: not stubbed" >&2; return 1; }
      case "$SAYS" in
        false|true) echo "$SAYS";;
        gone) echo "Error: No such object: $4" >&2; return 1;;
        error) echo "error during connect: the Docker daemon is not running" >&2; return 1;;
        race) rm -rf "$LOCK"; mkdir "$LOCK"; echo "lastmile-capture now" > "$LOCK/owner.txt"; echo false;;
      esac
    }
    source "${script}"
    [ "$LOCK" = "${slash(lockDir())}" ] || { echo "LOCK is not the sandbox's: $LOCK"; exit 9; }
    clear_dead_lock
  `, { SAYS: says });
  const remaining = () => (existsSync(path.join(lockDir(), "owner.txt")) ? readFileSync(path.join(lockDir(), "owner.txt"), "utf8").trim() : null);

  it("removes our lock once Docker says its container is stopped or gone", () => {
    for (const says of ["false", "gone"]) {
      holding(ours);
      expect(clear(says).out).toContain("removed a heavy lock");
      expect(existsSync(lockDir())).toBe(false);
    }
  });

  it("fails closed: a running container, or any Docker error, leaves the lock (a failed docker call was taken for 'gone')", () => {
    for (const says of ["true", "error"]) {
      holding(ours);
      clear(says);
      expect(remaining()).toBe(ours);
      rmSync(lockDir(), { recursive: true });
    }
  });

  it("leaves anyone else's lock, and ours without a full container id", () => {
    for (const holder of ["lastmile-capture 2026-10-30T00:00:00Z container=" + C, "reelwalk-local-worker 2026-10-30T00:00:00Z render job host=abc boot=1 #t"]) {
      holding(holder);
      clear("gone");
      expect(remaining()).toBe(holder);
      rmSync(lockDir(), { recursive: true });
    }
  });

  it("puts the lock back if it changed hands between the check and the removal", () => {
    holding(ours);
    clear("race");
    expect(remaining()).toBe("lastmile-capture now");
    expect(readdirSync(tmp).filter((name) => name.includes(".dead-") || name.endsWith(".cleanup"))).toEqual([]);
  });
});

describe.skipIf(!hasBash)("start.sh key: making the worker's AWS key", () => {
  const secrets = () => path.join(tmp, "secrets");
  const creds = () => path.join(secrets(), "aws-credentials");
  const calls = () => path.join(tmp, "calls");
  /** Runs make_key (or main key) against an IAM that holds `inIam` keys. */
  const key = (args: string, env: { IN_IAM?: string; CREATE_FAILS?: string } = {}, entry = "make_key") => bash(`
    fake_aws() {
      shift 4
      echo "$2" >> "$CALLS"
      case "$2" in
        list-access-keys) if [ -n "$IN_IAM" ]; then echo "$IN_IAM" | tr ' ' '\\t'; else echo None; fi;;
        delete-access-key) ;;
        create-access-key) [ "$CREATE_FAILS" = 1 ] && return 255; printf 'AKIAEXAMPLEKEY123456\\tsecretsecretsecretsecretsecretsecret1234\\n';;
      esac
    }
    source "${script}"
    mkdir -p "$REELWALK_SECRETS"
    rc=0; ${entry} ${args} || rc=$?
    echo "rc=$rc"
  `, { AWS_CLI: "fake_aws", REELWALK_SECRETS: slash(secrets()), CALLS: slash(calls()), IN_IAM: env.IN_IAM ?? "", CREATE_FAILS: env.CREATE_FAILS ?? "" });
  const made = () => (existsSync(calls()) ? readFileSync(calls(), "utf8").split("\n").filter((call) => call === "create-access-key").length : 0);
  const leftovers = () => (existsSync(secrets()) ? readdirSync(secrets()).filter((name) => name.startsWith(".aws-credentials.")) : []);

  it("makes one key and installs it complete", () => {
    expect(key("").out).toContain("rc=0");
    expect(readFileSync(creds(), "utf8")).toMatch(/^\[default\]\naws_access_key_id = AKIAEXAMPLEKEY123456\naws_secret_access_key = \S{30,}\n$/);
    expect(made()).toBe(1);
    expect(leftovers()).toEqual([]);
  });

  it("does nothing when this PC already holds the key IAM has", () => {
    mkdirSync(secrets());
    writeFileSync(creds(), "[default]\naws_access_key_id = AKIAEXAMPLEKEY123456\naws_secret_access_key = x\n");
    expect(key("", { IN_IAM: "AKIAEXAMPLEKEY123456" }).out).toContain("already set up");
    expect(made()).toBe(0);
  });

  it("refuses to mint a second key while IAM holds one this PC lacks, unless told to replace it", () => {
    expect(key("", { IN_IAM: "AKIAOTHERKEY00000000" }).out).toContain("rc=1");
    expect(made()).toBe(0);
    expect(key("--replace", { IN_IAM: "AKIAOTHERKEY00000000" }).out).toContain("rc=0");
    expect(readFileSync(calls(), "utf8")).toContain("delete-access-key");
    expect(made()).toBe(1);
  });

  it("installs nothing, and leaves nothing that blocks a retry, when AWS fails", () => {
    expect(key("", { CREATE_FAILS: "1" }).out).toContain("rc=1");
    expect(existsSync(creds())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(key("").out).toContain("rc=0");
    expect(existsSync(creds())).toBe(true);
  });

  it("lets only one key run at a time", () => {
    mkdirSync(path.join(secrets(), ".key.lock"), { recursive: true });
    const { out } = key("key)", {}, "(main");
    expect(out).toContain("another 'start.sh key' is running");
    expect(made()).toBe(0);
  });
});
