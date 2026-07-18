import { describe, expect, test } from "bun:test";
import {
  sampleBrushTexture,
  sampleBrushTip,
  texturedContactCoverage,
} from "./brush-textures";
import { RasterQuadTree } from "./quadtree";

describe("brush texture masks", () => {
  test("solid coverage remains uniform", () => {
    expect(sampleBrushTexture("solid", 12.4, -2, 7)).toBe(1);
  });

  test("bristle coverage is clipped across the brush tip", () => {
    expect(sampleBrushTexture("bristle", 0.5, -0.01, 7)).toBe(0);
    expect(sampleBrushTexture("bristle", 0.5, 1.01, 7)).toBe(0);
  });

  test("bristle tip uses the texture as its complete 2D silhouette", () => {
    expect(sampleBrushTip("bristle", -0.01, 0.5, 8)).toBe(0);
    expect(sampleBrushTip("bristle", 1.01, 0.5, 8)).toBe(0);

    const dot = new RasterQuadTree({ x: -64, y: -64, width: 128, height: 128 }).paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      24,
      24,
      "#000000",
      false,
      1,
      "bristle",
      8,
    );
    const bounds = dot.occupiedBounds();
    expect(bounds).not.toBeNull();
    expect(bounds!.width / bounds!.height).toBeGreaterThan(1.08);
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

  test("lower texture density lightens pigment and emphasizes its texture", () => {
    expect(texturedContactCoverage(1, 0.2)).toBeCloseTo(Math.sqrt(0.2), 12);
    expect(texturedContactCoverage(0.9, 0.2)).toBeCloseTo(0.9 ** 5 * Math.sqrt(0.2), 12);
    expect(texturedContactCoverage(1, 0.2, 0)).toBeGreaterThan(0);
    expect(texturedContactCoverage(1, 0.2, 0)).toBeLessThan(texturedContactCoverage(1, 0.2, 1));
    expect(texturedContactCoverage(0.5, 0.2)).toBeGreaterThan(0);
    expect(texturedContactCoverage(0.9, 1)).toBe(0.9);
  });

  test("a low-density bristle stamp stays continuous but carries less pigment", () => {
    const bounds = { x: -64, y: -64, width: 128, height: 128 };
    const stamp = (density: number) => new RasterQuadTree(bounds).paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      32,
      32,
      "#000000",
      false,
      density,
      "bristle",
      8,
    );
    const pigment = (tree: RasterQuadTree) => tree.allCells().reduce(
      (total, { bounds: cell, color }) => total + cell.width * cell.height * (color & 0xff),
      0,
    );
    const light = stamp(0.25);
    const full = stamp(1);
    expect(pigment(light)).toBeLessThan(pigment(full) * 0.75);
    expect(Math.max(...light.allCells().map(({ color }) => color & 0xff))).toBeGreaterThan(115);
    expect(Math.max(...light.allCells().map(({ color }) => color & 0xff))).toBeLessThan(140);
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
