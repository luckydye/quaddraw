import { describe, expect, test } from "bun:test";
import { DrawingStore } from "./drawing-store";
import { WORLD_BOUNDS } from "./types";

describe("DrawingStore velocity initialization", () => {
  test("does not paint a pen stroke before its initial velocity is known", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#393b42", 10);

    expect(store.visibleIn(WORLD_BOUNDS)).toHaveLength(0);

    // A long pointer-down pause followed by sub-pixel jitter must not classify
    // the whole startup as a slow, thick stroke.
    store.appendPoint(action, { x: 0.5, y: 0, time: 100 });

    expect(store.visibleIn(WORLD_BOUNDS)).toHaveLength(0);
    expect(action.points[0].strength).toBeUndefined();

    store.appendPoint(action, { x: 20, y: 0, time: 110 });

    expect(store.visibleIn(WORLD_BOUNDS).length).toBeGreaterThan(0);
    expect(action.points[0].strength).toBe(action.points[1].strength);
    expect(action.points[1].strength).toBe(action.points[2].strength);
    expect(action.points[0].strength).toBeLessThan(action.width);
  });

  test("does not inflate the stroke from stationary endpoint jitter", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#8855d4", 10);
    store.appendPoint(action, { x: 0.5, y: 0, time: 100 });
    store.appendPoint(action, { x: 20, y: 0, time: 110 });
    const startupWidth = action.points[action.points.length - 1].strength!;
    const pointCount = action.points.length;

    for (let index = 1; index <= 20; index++) {
      store.appendPoint(action, { x: 20 + index * 0.01, y: 0, time: 110 + index * 16 });
    }

    expect(action.points).toHaveLength(pointCount);
    expect(action.points[action.points.length - 1].strength).toBe(startupWidth);

    for (let index = 1; index <= 10; index++) {
      store.appendPoint(action, { x: 20 + index * 0.5, y: 0, time: 500 + index * 100 });
    }

    expect(action.points[action.points.length - 1].strength!).toBeLessThan(action.width);
  });
});
