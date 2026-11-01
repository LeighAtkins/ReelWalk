import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The worker runs some of the web app's own modules (ADR 0049, 0102, 0104) through its `@/` alias, but its image copies
 * only apps/web/lib and installs no Next.js or React. A module it loads that reaches `next/*` or `react`, even
 * transitively, crashes the worker on start. This walks every `@/` import in the worker's sources and fails on one.
 */
const web = path.resolve(__dirname, "..");
const worker = path.resolve(web, "../worker/src");

function resolve(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? path.join(web, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(from), spec) : null;
  if (!base) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) if (existsSync(candidate)) return candidate;
  return null;
}

/** Value imports only: `import type` is erased and never loads anything. */
function imports(file: string): string[] {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/^(import|export)\s(?!type\s)[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[2]);
}

function reaches(start: string, seen = new Set<string>()): string[] {
  if (seen.has(start)) return [];
  seen.add(start);
  const bad: string[] = [];
  for (const spec of imports(start)) {
    if (spec === "react" || spec.startsWith("react/") || spec === "next" || spec.startsWith("next/") || spec === "server-only") bad.push(`${path.relative(web, start)} imports ${spec}`);
    const next = resolve(start, spec);
    if (next) bad.push(...reaches(next, seen));
  }
  return bad;
}

describe("web modules the worker loads", () => {
  it("never reach Next.js or React", () => {
    const entries = readdirSync(worker).filter((f) => f.endsWith(".ts")).map((f) => path.join(worker, f));
    const fromWorker = entries.flatMap((file) => imports(file).filter((s) => s.startsWith("@/")).map((s) => resolve(file, s)!));
    expect(fromWorker.length).toBeGreaterThan(0);
    expect(fromWorker.flatMap((file) => reaches(file))).toEqual([]);
  });
});
