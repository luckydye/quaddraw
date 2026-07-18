import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";

const bounds = { x: -32, y: -32, width: 64, height: 64 };
const point = (x: number, y = 0) => ({ x, y });

describe("localized gesture-mask composition", () => {
  test("matches a full accumulated paint-mask recomposition", () => {
    const base = new RasterQuadTree(bounds).paintSegment(
      point(-24, -8),
      point(24, -8),
      8,
      8,
      "#336699",
      false,
      0.55,
    );
    const firstMask = new RasterQuadTree(bounds).paintSegment(
      point(-24),
      point(-2),
      10,
      10,
      "#000000",
      false,
      0.45,
    );
    const previous = base.applyMask(firstMask, "#d13b52");
    const nextMask = firstMask.paintSegment(
      point(-2),
      point(24),
      10,
      10,
      "#000000",
      false,
      0.45,
    );

    const localized = base.applyMaskRegion(
      nextMask,
      "#d13b52",
      false,
      { x: -9, y: -7, width: 40, height: 14 },
      previous,
    );
    const complete = base.applyMask(nextMask, "#d13b52");

    expect(localized.snapshot()).toEqual(complete.snapshot());
  });

  test("matches a full accumulated eraser-mask recomposition", () => {
    const base = new RasterQuadTree(bounds).paintSegment(
      point(-28),
      point(28),
      18,
      18,
      "#393b42",
    );
    const firstMask = new RasterQuadTree(bounds).paintSegment(
      point(-20),
      point(-4),
      7,
      7,
      "#000000",
    );
    const previous = base.applyMask(firstMask, "#000000", true);
    const nextMask = firstMask.paintSegment(
      point(-4),
      point(20),
      7,
      7,
      "#000000",
    );

    const localized = base.applyMaskRegion(
      nextMask,
      "#000000",
      true,
      { x: -9, y: -5, width: 35, height: 10 },
      previous,
    );
    const complete = base.applyMask(nextMask, "#000000", true);

    expect(localized.snapshot()).toEqual(complete.snapshot());
  });
});
