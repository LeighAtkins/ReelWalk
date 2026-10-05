import { describe, expect, it } from "vitest";
import { renderConcurrency } from "../src/concurrency";

describe("renderConcurrency", () => {
  it("uses four tabs by default on a machine that has them", () => {
    expect(renderConcurrency(undefined, 24)).toBe(4);
  });

  it("never asks for more tabs than the machine has cores", () => {
    expect(renderConcurrency(4, 2)).toBe(2);
    expect(renderConcurrency(undefined, 2)).toBe(2);
    expect(renderConcurrency(8, 1)).toBe(1);
  });

  it("honours a lower setting and ignores nonsense", () => {
    expect(renderConcurrency(2, 24)).toBe(2);
    expect(renderConcurrency(0, 24)).toBe(4);
    expect(renderConcurrency(Number.NaN, 8)).toBe(4);
    expect(renderConcurrency(3.9, 8)).toBe(3);
  });
});
