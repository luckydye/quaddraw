import { describe, expect, test } from "bun:test";
import { cameraAfterGesture, gestureFrame } from "./canvas-navigation";

describe("canvas navigation gestures", () => {
  test("reads the center and distance of two touches", () => {
    expect(gestureFrame([{ x: 10, y: 20 }, { x: 30, y: 60 }])).toEqual({
      center: { x: 20, y: 40 },
      distance: Math.hypot(20, 40),
    });
  });

  test("pans with a moving two-finger gesture", () => {
    expect(cameraAfterGesture(
      { x: 5, y: 10, zoom: 1 },
      { center: { x: 40, y: 50 }, distance: 20 },
      { center: { x: 52, y: 43 }, distance: 20 },
      0.2,
      4,
    )).toEqual({ x: 17, y: 3, zoom: 1 });
  });

  test("zooms around the gesture center and respects zoom limits", () => {
    const camera = cameraAfterGesture(
      { x: 0, y: 0, zoom: 3 },
      { center: { x: 100, y: 80 }, distance: 20 },
      { center: { x: 100, y: 80 }, distance: 40 },
      0.2,
      4,
    );
    expect(camera.zoom).toBe(4);
    expect(camera.x).toBeCloseTo(-100 / 3);
    expect(camera.y).toBeCloseTo(-80 / 3);
  });
});
