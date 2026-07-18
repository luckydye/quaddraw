import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";
import { WORLD_BOUNDS } from "./types";

describe("RasterQuadTree", () => {
  test("stores brush output in spatially queryable leaves", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const painted = empty.paintSegment({ x: 0, y: 0 }, { x: 40, y: 20 }, 6, 6, "#393b42");

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
    const painted = empty.paintSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 100_000, 100_000, "#f35b4c");
    const erased = painted.paintSegment({ x: 0, y: 0 }, { x: 0, y: 0 }, 100_000, 100_000, "#000000", true);

    expect(painted.countNodes()).toBe(1);
    expect(painted.allCells()).toHaveLength(1);
    expect(erased.countNodes()).toBe(1);
    expect(erased.allCells()).toHaveLength(0);
  });

  test("shares unchanged versions instead of mutating history", () => {
    const first = new RasterQuadTree(WORLD_BOUNDS);
    const second = first.paintSegment({ x: 10, y: 10 }, { x: 15, y: 15 }, 3, 3, "#4c8deb");
    const noChange = first.paintSegment({ x: 10, y: 10 }, { x: 15, y: 15 }, 3, 3, "#000000", true);

    expect(first.allCells()).toHaveLength(0);
    expect(second.allCells().length).toBeGreaterThan(0);
    expect(noChange).toBe(first);
  });

  test("interpolates width continuously across a segment", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      2,
      20,
      "#393b42",
    );

    expect(tree.cellsIn({ x: -1, y: 6, width: 2, height: 1 })).toHaveLength(0);
    expect(tree.cellsIn({ x: 38, y: 6, width: 2, height: 1 }).length).toBeGreaterThan(0);
  });

  test("does not accumulate alpha where same-color brush sections overlap", () => {
    const once = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      3,
      3,
      "#393b42",
    );
    const twice = once.paintSegment(
      { x: 0, y: 0 },
      { x: 30, y: 10 },
      3,
      3,
      "#393b42",
    );

    expect(twice.snapshot()).toEqual(once.snapshot());
  });

  test("uses brush density as paint opacity", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#4c8deb",
      false,
      0.4,
    );

    expect(tree.allCells()).toHaveLength(1);
    expect(tree.allCells()[0].color & 0xff).toBe(102);
  });

  test("composites a unioned stroke mask only once over another color", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const red = empty.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#f35b4c",
      false,
      0.5,
    );
    const mask = empty.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#000000",
      false,
      0.5,
    );
    const overlappingMask = mask.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#000000",
      false,
      0.5,
    );

    const once = red.applyMask(mask, "#4c8deb");
    const withOverlappingSegments = red.applyMask(overlappingMask, "#4c8deb");

    expect(withOverlappingSegments.snapshot()).toEqual(once.snapshot());
    expect(once.snapshot()).not.toEqual(red.snapshot());
    const mixedColor = once.allCells()[0].color;
    expect((mixedColor >>> 24) & 0xff).toBeGreaterThan(0x4c);
    expect((mixedColor >>> 8) & 0xff).toBeLessThan(0xeb);
  });

  test("aggregates subpixel branches when rendering zoomed out", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -200, y: -100 },
      { x: 200, y: 100 },
      12,
      12,
      "#4c8deb",
    );

    expect(tree.cellsForRendering(WORLD_BOUNDS, 0.1).length).toBeLessThan(tree.allCells().length);
    expect(tree.debugLeavesIn(WORLD_BOUNDS, 0.1).length).toBeLessThan(tree.debugLeavesIn(WORLD_BOUNDS).length);
  });
});
