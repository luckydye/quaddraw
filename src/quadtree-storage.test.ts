import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";
import {
  decodeDrawing,
  decodeQuadTree,
  encodeDrawing,
  encodeDrawingIncrementally,
  encodeQuadTree,
  encodeQuadTreeIncrementally,
} from "./quadtree-storage";
import type { DrawingDocument } from "./drawing-document";
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

  test("incremental encoding is byte-identical to synchronous encoding", async () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -80, y: 40 },
      { x: 120, y: -60 },
      12,
      5,
      "#53b66e",
    );

    const synchronous = encodeQuadTree(tree, 11);
    const incremental = await encodeQuadTreeIncrementally(tree, 11);

    expect(incremental).toEqual(synchronous);
  });
});

describe("layered drawing snapshots", () => {
  test("round-trips ordered layer metadata and independent trees", async () => {
    const bottomTree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -20, y: 0 },
      { x: 20, y: 0 },
      8,
      8,
      "#f35b4c",
    );
    const topTree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: -20 },
      { x: 0, y: 20 },
      5,
      5,
      "#4c8deb",
    );
    const document: DrawingDocument = {
      layers: [
        { id: 4, name: "Background", visible: true, opacity: 1, tree: bottomTree, strokeCount: 2 },
        { id: 9, name: "Glanz ✨", visible: false, opacity: 0.35, tree: topTree, strokeCount: 3 },
      ],
      activeLayerId: 9,
      nextLayerId: 10,
    };

    const synchronous = encodeDrawing(document);
    const incremental = await encodeDrawingIncrementally(document);
    const decoded = decodeDrawing(synchronous);

    expect(incremental).toEqual(synchronous);
    expect(decoded?.version).toBe(3);
    expect(decoded?.document.activeLayerId).toBe(9);
    expect(decoded?.document.nextLayerId).toBe(10);
    expect(decoded?.document.layers.map(({ tree: _tree, ...metadata }) => metadata)).toEqual([
      { id: 4, name: "Background", visible: true, opacity: 1, strokeCount: 2 },
      { id: 9, name: "Glanz ✨", visible: false, opacity: expect.closeTo(0.35), strokeCount: 3 },
    ]);
    expect(decoded?.document.layers[0].tree.snapshot()).toEqual(bottomTree.snapshot());
    expect(decoded?.document.layers[1].tree.snapshot()).toEqual(topTree.snapshot());
  });

  test("promotes a version 2 raster snapshot into a one-layer document", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      4,
      4,
      "#53b66e",
    );

    const decoded = decodeDrawing(encodeQuadTree(tree, 6));

    expect(decoded?.version).toBe(2);
    expect(decoded?.document.layers).toHaveLength(1);
    expect(decoded?.document.layers[0].strokeCount).toBe(6);
    expect(decoded?.document.layers[0].tree.snapshot()).toEqual(tree.snapshot());
  });
});
