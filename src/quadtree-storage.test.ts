import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";
import { decodeQuadTree, encodeQuadTree } from "./quadtree-storage";
import { WORLD_BOUNDS } from "./types";

describe("compact quadtree snapshots", () => {
  test("round-trips topology while substantially reducing raw size", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -100, y: -50 },
      { x: 100, y: 50 },
      8,
      14,
      "#8855d4",
    );
    const bytes = encodeQuadTree(tree, 7);
    const decoded = decodeQuadTree(bytes);
    const branchCount = (tree.countNodes() - 1) / 4;
    const legacyBytes = 10 + branchCount + (tree.countNodes() - branchCount) * 5;

    expect(decoded).not.toBeNull();
    expect(decoded!.strokeCount).toBe(7);
    expect(decoded!.version).toBe(2);
    expect(decoded!.tree.snapshot()).toEqual(tree.snapshot());
    expect(bytes.byteLength).toBeLessThan(legacyBytes / 2);
  });

  test("still reads version 1 snapshots", () => {
    const buffer = new ArrayBuffer(15);
    const view = new DataView(buffer);
    view.setUint32(0, 0x51445232, true);
    view.setUint16(4, 1, true);
    view.setUint32(6, 3, true);
    view.setUint8(10, 0);
    view.setUint32(11, 0x8855d4ff, true);

    const decoded = decodeQuadTree(new Uint8Array(buffer));

    expect(decoded?.version).toBe(1);
    expect(decoded?.strokeCount).toBe(3);
    expect(decoded?.tree.snapshot()).toEqual({ color: 0x8855d4ff });
  });
});
