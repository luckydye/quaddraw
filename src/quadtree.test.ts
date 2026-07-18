import { describe, expect, test } from "bun:test";
import { createBranchNode, RasterQuadTree } from "./quadtree";
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

  test("reports the effective resolution of occupied bounds", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const partial = empty.paintSegment({ x: 0, y: 0 }, { x: 40, y: 20 }, 6, 6, "#393b42");
    const full = empty.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#393b42",
    );

    expect(empty.occupiedResolution()).toEqual({ width: 0, height: 0 });
    expect(partial.occupiedResolution().width).toBeGreaterThan(0);
    expect(partial.occupiedResolution().height).toBeGreaterThan(0);
    expect(partial.occupiedResolution().width).toBeLessThan(32_768);
    expect(partial.occupiedResolution().height).toBeLessThan(32_768);
    expect(full.occupiedResolution()).toEqual({ width: 32_768, height: 32_768 });
  });

  test("keeps cached occupied bounds correct across immutable edits", () => {
    const first = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -200, y: 0 },
      { x: -100, y: 0 },
      12,
      12,
      "#393b42",
    );
    const firstBounds = first.occupiedBounds()!;
    expect(first.occupiedBounds()).toEqual(firstBounds);

    const expanded = first.paintSegment(
      { x: 100, y: 0 },
      { x: 200, y: 0 },
      12,
      12,
      "#393b42",
    );
    const expandedBounds = expanded.occupiedBounds()!;

    expect(expandedBounds.x).toBe(firstBounds.x);
    expect(expandedBounds.x + expandedBounds.width).toBeGreaterThan(200);
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

  test("interpolates pressure-driven density along a segment", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      0.1,
      "solid",
      0,
      1,
    );
    const maximumAlpha = (x: number) => Math.max(...tree.cellsIn({ x, y: -1, width: 3, height: 2 })
      .map((cell) => cell.color & 0xff));

    expect(maximumAlpha(36)).toBeGreaterThan(maximumAlpha(1));
  });

  test("uses increased pressure for a stationary pen sample", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      2,
      10,
      "#393b42",
      false,
      0.1,
      "solid",
      0,
      1,
    );

    expect(tree.cellsIn({ x: 3, y: -1, width: 1, height: 2 }).length).toBeGreaterThan(0);
    expect(Math.max(...tree.cellsIn({ x: -1, y: -1, width: 2, height: 2 })
      .map((cell) => cell.color & 0xff))).toBe(255);
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

  test("darkens where separate same-color stroke masks overlap", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const firstStroke = empty.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#53b66e",
      false,
      0.5,
    );
    const secondStrokeMask = empty.paintSegment(
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      100_000,
      100_000,
      "#000000",
      false,
      0.5,
    );

    const layered = firstStroke.applyMask(secondStrokeMask, "#53b66e");

    expect(firstStroke.allCells()[0].color & 0xff).toBe(128);
    expect(layered.allCells()[0].color & 0xff).toBe(192);
  });

  test("creates stable grain for textured brush masks", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const paintCharcoal = (seed: number) => empty.paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      1,
      "charcoal",
      seed,
    );
    const charcoal = paintCharcoal(123);
    const sameCharcoal = paintCharcoal(123);
    const differentCharcoal = paintCharcoal(456);

    expect(sameCharcoal.snapshot()).toEqual(charcoal.snapshot());
    expect(differentCharcoal.snapshot()).not.toEqual(charcoal.snapshot());
    expect(new Set(charcoal.allCells().map((cell) => cell.color & 0xff)).size).toBeGreaterThan(10);
    expect(charcoal.paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      1,
      "charcoal",
      123,
    ).snapshot()).toEqual(charcoal.snapshot());
  });

  test("gives charcoal less uniform ink coverage than solid", () => {
    const empty = new RasterQuadTree(WORLD_BOUNDS);
    const paint = (texture: "solid" | "charcoal") => empty.paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      1,
      texture,
      123,
    );
    const inkCoverage = (tree: RasterQuadTree) => tree.allCells().reduce(
      (total, cell) => total + cell.bounds.width * cell.bounds.height * (cell.color & 0xff) / 255,
      0,
    );

    const solidCoverage = inkCoverage(paint("solid"));
    const charcoalCoverage = inkCoverage(paint("charcoal"));

    expect(charcoalCoverage).toBeLessThan(solidCoverage);
  });

  test("keeps charcoal grain tonal through the stroke core", () => {
    const charcoal = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      1,
      "charcoal",
      123,
    );
    const cells = charcoal.cellsIn({ x: 0, y: -2, width: 40, height: 4 });

    for (let x = 0; x <= 40; x += 2) {
      for (let y = -2; y <= 2; y += 2) {
        expect(cells.some((cell) =>
          x >= cell.bounds.x
          && x < cell.bounds.x + cell.bounds.width
          && y >= cell.bounds.y
          && y < cell.bounds.y + cell.bounds.height
        )).toBe(true);
      }
    }
  });

  test("feathers charcoal coverage toward its outer edge", () => {
    const charcoal = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      10,
      10,
      "#393b42",
      false,
      1,
      "charcoal",
      123,
    );
    const cells = charcoal.allCells();
    const alphaAt = (x: number, y: number) => cells.find((cell) =>
      x >= cell.bounds.x
      && x < cell.bounds.x + cell.bounds.width
      && y >= cell.bounds.y
      && y < cell.bounds.y + cell.bounds.height
    )?.color as number | undefined;
    const coreAlpha = (alphaAt(20, 0) ?? 0) & 0xff;
    const edgeAlpha = (alphaAt(20, 5) ?? 0) & 0xff;

    expect(edgeAlpha).toBeGreaterThan(0);
    expect(edgeAlpha).toBeLessThan(coreAlpha);
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

  test("expands a marquee hit to the complete connected ink island", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS)
      .paintSegment({ x: 0, y: 0 }, { x: 80, y: 0 }, 6, 6, "#393b42")
      .paintSegment({ x: 200, y: 0 }, { x: 240, y: 0 }, 6, 6, "#f35b4c");

    const selection = tree.connectedIslandsTouching({ x: -4, y: -4, width: 8, height: 8 });

    expect(selection).not.toBeNull();
    expect(selection!.islandCount).toBe(1);
    expect(selection!.bounds.x + selection!.bounds.width).toBeGreaterThan(75);
    expect(selection!.bounds.x + selection!.bounds.width).toBeLessThan(100);
    expect(selection!.cells.every((cell) => cell.bounds.x < 100)).toBe(true);
  });

  test("selects every disconnected island touched by one marquee", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS)
      .paintSegment({ x: 0, y: 0 }, { x: 20, y: 0 }, 6, 6, "#393b42")
      .paintSegment({ x: 60, y: 0 }, { x: 80, y: 0 }, 6, 6, "#4c8deb");

    const selection = tree.connectedIslandsTouching({ x: -10, y: -10, width: 100, height: 20 });

    expect(selection?.islandCount).toBe(2);
    expect(selection!.bounds.width).toBeGreaterThan(75);
  });

  test("treats diagonally touching occupied leaves as one island", () => {
    const transparent = { color: 0 } as const;
    const ink = { color: 0x393b42ff } as const;
    const tree = RasterQuadTree.fromSnapshot(
      { x: 0, y: 0, width: 2, height: 2 },
      createBranchNode([ink, transparent, transparent, ink]),
    );

    const selection = tree.connectedIslandsTouching({ x: 0, y: 0, width: 0.5, height: 0.5 });

    expect(selection?.islandCount).toBe(1);
    expect(selection?.cells).toHaveLength(2);
    expect(selection?.bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  test("cuts and moves selected raster cells without changing their coverage", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS)
      .paintSegment({ x: 0, y: 0 }, { x: 30, y: 10 }, 8, 8, "#4c8deb")
      .paintSegment({ x: 150, y: 0 }, { x: 180, y: 0 }, 8, 8, "#f35b4c");
    const selection = tree.connectedIslandsTouching({ x: -5, y: -5, width: 10, height: 10 })!;
    const offset = tree.snapTranslation(60, 25);
    const coverage = (cells: readonly { bounds: { width: number; height: number }; color: number }[]) =>
      cells.reduce((total, cell) =>
        total + cell.bounds.width * cell.bounds.height * (cell.color & 0xff) / 255, 0);

    const moved = tree.moveCells(selection.cells, offset.x, offset.y);
    const movedSelection = moved.connectedIslandsTouchingAreas(selection.cells.map((cell) => ({
      ...cell.bounds,
      x: cell.bounds.x + offset.x,
      y: cell.bounds.y + offset.y,
    })))!;

    expect(tree.connectedIslandsTouching({ x: -5, y: -5, width: 10, height: 10 })).not.toBeNull();
    expect(moved.connectedIslandsTouching({ x: -5, y: -5, width: 10, height: 10 })).toBeNull();
    expect(moved.connectedIslandsTouching({ x: 145, y: -5, width: 45, height: 10 })).not.toBeNull();
    expect(coverage(movedSelection.cells)).toBeCloseTo(coverage(selection.cells), 6);
  });

  test("returns current leaf addresses so a large selection can move repeatedly", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS)
      .paintSegment({ x: 0, y: 0 }, { x: 120, y: 20 }, 10, 10, "#8855d4");
    const selection = tree.connectedIslandsTouching({ x: -6, y: -6, width: 12, height: 12 })!;
    const firstOffset = tree.snapTranslation(180, 40);
    const firstMove = tree.moveSelection(selection, firstOffset.x, firstOffset.y);
    const secondOffset = firstMove.tree.snapTranslation(80, -30);

    const secondMove = firstMove.tree.moveSelection(
      firstMove.selection,
      secondOffset.x,
      secondOffset.y,
    );

    expect(firstMove.selection.cells.length).toBeGreaterThan(0);
    expect(secondMove.selection.cells.length).toBeGreaterThan(0);
    expect(secondMove.tree.connectedIslandsTouching({
      x: 250,
      y: 0,
      width: 150,
      height: 50,
    })).not.toBeNull();
  });

  test("keeps moved selection bounds local when compositing onto the same color", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS)
      .paintSegment({ x: 0, y: 0 }, { x: 40, y: 0 }, 8, 8, "#393b42")
      .paintSegment({ x: 200, y: 0 }, { x: 500, y: 0 }, 8, 8, "#393b42");
    const selection = tree.connectedIslandsTouching({ x: -5, y: -5, width: 10, height: 10 })!;
    const offset = tree.snapTranslation(200, 0);

    const moved = tree.moveSelection(selection, offset.x, offset.y);

    expect(moved.selection.cells.length).toBeGreaterThan(0);
    expect(moved.selection.bounds.x).toBeGreaterThan(190);
    expect(moved.selection.bounds.width).toBeLessThan(60);
  });
});
