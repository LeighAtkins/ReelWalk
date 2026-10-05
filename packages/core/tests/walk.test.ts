import { describe, expect, it } from "vitest";
import { cameraAt, clipSchema, doorRoute, normalizePlan, shortestTurn, walkInto, type Clip } from "../src";

// Two rooms side by side, joined by a door near the top of the shared wall.
const { plan } = normalizePlan(
  [
    [[0, 0], [10, 0], [10, 10], [0, 10]],
    [[10, 0], [20, 0], [20, 10], [10, 10]],
  ],
  [[[10, 1], [10, 2]]],
);

const pano = (id: string, x: number, y: number, yawStart: number, yawEnd: number, transitionIn: Clip["transitionIn"] = "walk"): Clip =>
  clipSchema.parse({
    id,
    assetId: id,
    kind: "IMAGE",
    sourceStartMs: 0,
    sourceEndMs: 5000,
    transitionIn,
    pano: { yawStart, yawEnd },
    spot: { x, y, heading: 0 },
  });

const a = pano("a", 0.25, 0.8, -60, 20, "cut");
const b = pano("b", 0.75, 0.8, 90, 170);

describe("doorRoute", () => {
  it("goes through the door between two rooms", () => {
    const route = doorRoute(plan, [0.25, 0.8], [0.75, 0.8]);
    expect(route).toHaveLength(3);
    expect(route[1][0]).toBeCloseTo(0.5, 3);
    expect(route[1][1]).toBeCloseTo(0.15, 3);
  });

  it("is a straight line inside one room or without a plan", () => {
    expect(doorRoute(plan, [0.1, 0.1], [0.4, 0.9])).toHaveLength(2);
    expect(doorRoute(null, [0.25, 0.8], [0.75, 0.8])).toHaveLength(2);
  });
});

describe("shortestTurn", () => {
  it("turns the short way round", () => {
    expect(shortestTurn(170, -170)).toBe(20);
    expect(shortestTurn(-170, 170)).toBe(-20);
  });
});

describe("cameraAt", () => {
  it("only walks between two located 360 photos", () => {
    expect(walkInto(plan, a, { ...b, transitionIn: "fade" }, 5000)).toBeNull();
    expect(walkInto(plan, { ...a, spot: null }, b, 5000)).toBeNull();
    expect(walkInto(plan, a, b, 5000)).not.toBeNull();
  });

  it("starts exactly where the last clip ended and ends on the new clip's sweep", () => {
    const start = cameraAt(plan, a, b, 0, 5000);
    expect(start).toMatchObject({ x: 0.25, y: 0.8, previous: 1 });
    expect(shortestTurn(start.heading, 20)).toBeCloseTo(0, 6);
    const end = cameraAt(plan, a, b, 5000, 5000);
    expect(end.x).toBeCloseTo(0.75, 6);
    expect(end.y).toBeCloseTo(0.8, 6);
    expect(end.previous).toBe(0);
    expect(shortestTurn(end.heading, 170)).toBeCloseTo(0, 6);
  });

  it("passes through the doorway", () => {
    const walk = walkInto(plan, a, b, 5000)!;
    const nearest = Math.min(
      ...Array.from({ length: 200 }, (_, i) => {
        const pose = cameraAt(plan, a, b, (walk.durationMs * i) / 199, 5000);
        return Math.hypot(pose.x - 0.5, pose.y - 0.15);
      }),
    );
    expect(nearest).toBeLessThan(0.01);
  });

  it("never moves or turns abruptly", () => {
    // Frame to frame at 30 fps over the whole clip.
    const poses = Array.from({ length: 151 }, (_, frame) => cameraAt(plan, a, b, (frame * 1000) / 30, 5000));
    const steps = poses.slice(1).map((pose, index) => Math.hypot((pose.x - poses[index].x) * plan.aspect, pose.y - poses[index].y));
    const turns = poses.slice(1).map((pose, index) => Math.abs(pose.heading - poses[index].heading) * 30);
    // Speed builds up and dies away gradually: no step differs much from the one before it.
    const largest = Math.max(...steps);
    steps.slice(1).forEach((step, index) => expect(Math.abs(step - steps[index])).toBeLessThan(largest * 0.2));
    // Turning stays under 130 degrees a second, and starts and ends at rest.
    expect(Math.max(...turns)).toBeLessThan(130);
    expect(turns[0]).toBeLessThan(5);
    expect(turns[turns.length - 1]).toBeLessThan(5);
  });
});
