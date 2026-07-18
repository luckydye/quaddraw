import { describe, expect, test } from "bun:test";
import { createDrawingDocument, replaceLayer } from "./drawing-document";
import {
  decodeDrawing,
  encodeDrawing,
  encodeDrawingIncrementally,
} from "./quadtree-storage";

describe("incremental drawing snapshots", () => {
  test("match the synchronous QDR3 encoding without retaining a node array", async () => {
    const empty = createDrawingDocument();
    const document = replaceLayer(empty, empty.activeLayerId, (layer) => ({
      ...layer,
      strokeCount: 1,
      tree: layer.tree.paintSegment(
        { x: -180, y: -40 },
        { x: 190, y: 75 },
        28,
        17,
        "#d13b52",
        false,
        0.62,
        "charcoal",
        41,
      ),
    }));

    const expected = encodeDrawing(document);
    const incremental = await encodeDrawingIncrementally(document);

    expect(incremental).not.toBeNull();
    if (!incremental) throw new Error("Incremental snapshot was unexpectedly cancelled");
    expect(incremental).toEqual(expected);
    expect(decodeDrawing(incremental)?.document.layers[0].tree.snapshot()).toEqual(
      document.layers[0].tree.snapshot(),
    );
  });

  test("can abandon a stale snapshot before traversing the full tree", async () => {
    const document = createDrawingDocument();
    let checks = 0;

    const snapshot = await encodeDrawingIncrementally(
      document,
      () => ++checks < 2,
    );

    expect(snapshot).toBeNull();
  });
});
