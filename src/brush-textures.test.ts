import { describe, expect, test } from "bun:test";
import { sampleBrushTexture } from "./brush-textures";
import { RasterQuadTree } from "./quadtree";

describe("brush texture masks", () => {
  test("solid coverage remains uniform", () => {
    expect(sampleBrushTexture("solid", 12.4, -2, 7)).toBe(1);
  });

  test("bristle coverage is clipped across the brush tip", () => {
    expect(sampleBrushTexture("bristle", 0.5, -0.01, 7)).toBe(0);
    expect(sampleBrushTexture("bristle", 0.5, 1.01, 7)).toBe(0);
  });

  test("bristle texture does not flatten the circular tip silhouette", () => {
    const top = Array.from(
      { length: 33 },
      (_, index) => sampleBrushTexture("bristle", index / 32, 0, 8),
    );
    const bottom = Array.from(
      { length: 33 },
      (_, index) => sampleBrushTexture("bristle", index / 32, 1, 8),
    );
    expect(Math.max(...top)).toBeGreaterThan(0.6);
    expect(Math.max(...bottom)).toBeGreaterThan(0.6);
  });

  test("bristle mask contains real two-dimensional opacity variation", () => {
    const samples = Array.from({ length: 17 * 9 }, (_, index) => {
      const x = index % 17;
      const y = Math.floor(index / 17);
      return sampleBrushTexture("bristle", x / 16, y / 8, 11);
    });
    expect(Math.max(...samples)).toBeGreaterThan(0.9);
    expect(Math.min(...samples)).toBeLessThan(0.1);
  });

  test("mirrored repetition has no wrap discontinuity", () => {
    const first = sampleBrushTexture("bristle", 0.37, 0.48, 23);
    const repeated = sampleBrushTexture("bristle", 2.37, 0.48, 23);
    expect(repeated).toBeCloseTo(first, 12);
  });

  test("charcoal keeps its procedural grain coverage", () => {
    const tree = new RasterQuadTree({ x: -32, y: -32, width: 64, height: 64 }).paintSegment(
      { x: -20, y: 0 },
      { x: 20, y: 0 },
      18,
      18,
      "#000000",
      false,
      1,
      "charcoal",
      41,
    );
    const alphas = new Set(tree.allCells().map(({ color }) => color & 0xff));
    expect(alphas.size).toBeGreaterThan(8);
  });
});
