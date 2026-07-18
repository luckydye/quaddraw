import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";
import { WORLD_BOUNDS } from "./types";

describe("RasterQuadTree", () => {
  test("stores brush output in spatially queryable leaves", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const painted = empty.paintSegment({ x: 0, y: 0 }, { x: 40, y: 20 }, 6, "#393b42");

    expect(empty.countNodes()).toBe(1);
    expect(empty.allCells()).toHaveLength(0);
    expect(painted.countNodes()).toBeGreaterThan(1);
    expect(painted.cellsIn({ x: -5, y: -5, width: 55, height: 35 }).length).toBeGreaterThan(0);
    expect(painted.cellsIn({ x: 500, y: 500, width: 20, height: 20 })).toHaveLength(0);

    const debugRegions = painted.debugLeavesIn({ x: -5, y: -5, width: 55, height: 35 });
    expect(debugRegions.some((region) => region.occupied)).toBe(true);
    expect(debugRegions.some((region) => !region.occupied)).toBe(true);
    expect(debugRegions.some((region) => region.depth > 0)).toBe(true);
  });

  test("collapses uniform painted and erased regions", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const painted = empty.paintSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 100_000, "#f35b4c");
    const erased = painted.paintSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 100_000, "#000000", true);

    expect(painted.countNodes()).toBe(1);
    expect(painted.allCells()).toHaveLength(1);
    expect(erased.countNodes()).toBe(1);
    expect(erased.allCells()).toHaveLength(0);
  });

  test("shares unchanged versions instead of mutating history", () => {
    const first = new RasterQuadTree(WORLD_BOUNDS);
    const second = first.paintSegment({ x: 10, y: 10 }, { x: 15, y: 15 }, 3, "#4c8deb");
    const noChange = first.paintSegment({ x: 10, y: 10 }, { x: 15, y: 15 }, 3, "#000000", true);

    expect(first.allCells()).toHaveLength(0);
    expect(second.allCells().length).toBeGreaterThan(0);
    expect(noChange).toBe(first);
  });
});
