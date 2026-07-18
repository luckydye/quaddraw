import { describe, expect, test } from "bun:test";
import { RasterQuadTree } from "./quadtree";
import {
  applyLayerMetadata,
  decodeDrawing,
  encodeDrawing,
  encodeDrawingIncrementally,
} from "./quadtree-storage";
import type { DrawingDocument } from "./drawing-document";
import { WORLD_BOUNDS } from "./types";

describe("compact QDR3 snapshots", () => {
  test("round-trips topology while substantially reducing raw size", () => {
    const tree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: -100, y: -50 },
      { x: 100, y: 50 },
      8,
      14,
      "#8855d4",
    );
    const document: DrawingDocument = {
      layers: [{
        id: 1,
        name: "Paint",
        visible: true,
        opacity: 1,
        tree,
        strokeCount: 7,
      }],
      activeLayerId: 1,
      nextLayerId: 2,
    };
    const bytes = encodeDrawing(document);
    const decoded = decodeDrawing(bytes);
    const branchCount = (tree.countNodes() - 1) / 4;
    const unpackedTreeBytes = branchCount + (tree.countNodes() - branchCount) * 5;

    expect(decoded).not.toBeNull();
    expect(decoded!.document.layers[0].strokeCount).toBe(7);
    expect(decoded!.document.layers[0].tree.snapshot()).toEqual(tree.snapshot());
    expect(bytes.byteLength).toBeLessThan(unpackedTreeBytes / 2);
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
    expect(decoded?.document.activeLayerId).toBe(9);
    expect(decoded?.document.nextLayerId).toBe(10);
    expect(decoded?.document.layers.map(({ tree: _tree, ...metadata }) => metadata)).toEqual([
      { id: 4, name: "Background", visible: true, opacity: 1, strokeCount: 2 },
      { id: 9, name: "Glanz ✨", visible: false, opacity: expect.closeTo(0.35), strokeCount: 3 },
    ]);
    expect(decoded?.document.layers[0].tree.snapshot()).toEqual(bottomTree.snapshot());
    expect(decoded?.document.layers[1].tree.snapshot()).toEqual(topTree.snapshot());
  });

  test("restores the latest layer manifest without replacing raster trees", () => {
    const firstTree = new RasterQuadTree(WORLD_BOUNDS).paintSegment(
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      4,
      4,
      "#f35b4c",
    );
    const secondTree = new RasterQuadTree(WORLD_BOUNDS);
    const document: DrawingDocument = {
      layers: [
        { id: 1, name: "First", visible: false, opacity: 1, tree: firstTree, strokeCount: 1 },
        { id: 2, name: "Second", visible: true, opacity: 1, tree: secondTree, strokeCount: 0 },
      ],
      activeLayerId: 2,
      nextLayerId: 3,
    };

    const restored = applyLayerMetadata(document, {
      version: 1,
      activeLayerId: 1,
      layers: [
        { id: 2, name: "Top", visible: false, opacity: 0.5 },
        { id: 1, name: "Visible", visible: true, opacity: 0.8 },
      ],
    });

    expect(restored.activeLayerId).toBe(1);
    expect(restored.layers.map(({ id }) => id)).toEqual([2, 1]);
    expect(restored.layers[1].visible).toBe(true);
    expect(restored.layers[1].tree).toBe(firstTree);
    expect(restored.layers[0].tree).toBe(secondTree);
  });
});
