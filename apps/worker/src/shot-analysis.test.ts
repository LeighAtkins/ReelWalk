import { describe, expect, it } from "vitest";
import { depthSample, iqaScore } from "./shot-analysis";

describe("shot analysis helpers", () => {
  it("scores an image embedding by how much nearer it is to each good prompt than to its bad twin", () => {
    const good = [1, 0, 0], bad = [0, 1, 0];
    expect(iqaScore([0.9, 0.1, 0], [good, bad])).toBeGreaterThan(0.99);
    expect(iqaScore([0.1, 0.9, 0], [good, bad])).toBeLessThan(0.01);
    expect(iqaScore([1, 1, 0], [good, bad])).toBeCloseTo(0.5);
  });
  it("reduces a depth map to a nearness grid and finds a near post on the right", () => {
    const width = 64, height = 36;
    const data = new Float32Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = x > 52 ? 10 : 1 + y / height; // inverse depth: larger is nearer
    const sample = depthSample(500, { data, width, height });
    expect(sample.cols * sample.rows).toBe(Buffer.from(sample.grid, "base64").length);
    expect(sample.near).not.toBeNull();
    expect(sample.near!.x).toBeGreaterThan(0.75);
    expect(sample.foreground).toBeGreaterThan(0.1);
    const flat = depthSample(0, { data: new Float32Array(width * height).fill(5), width, height });
    expect(flat.spread).toBeLessThan(0.05);
    expect(sample.spread).toBeGreaterThan(0.5);
  });
});
