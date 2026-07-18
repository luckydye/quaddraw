import { describe, expect, test } from "bun:test";
import {
  createBranchNode,
  RasterQuadTree,
  type QuadNode,
} from "./quadtree";

const transparent = (): QuadNode => ({ color: 0 });
const ink = (): QuadNode => ({ color: 0x000000ff });

describe("connected island selection", () => {
  test("treats leaves meeting at one corner as one 8-connected island", () => {
    const root = createBranchNode([ink(), transparent(), transparent(), ink()]);
    const tree = RasterQuadTree.fromSnapshot({ x: 0, y: 0, width: 4, height: 4 }, root);
    const selection = tree.connectedIslandsTouching({ x: 0, y: 0, width: 1, height: 1 });

    expect(selection?.islandCount).toBe(1);
    expect(selection?.cells).toHaveLength(2);
  });

  test("keeps spatially separated leaves in distinct components", () => {
    const topLeft = createBranchNode([
      ink(),
      transparent(),
      transparent(),
      transparent(),
    ]);
    const bottomRight = createBranchNode([
      transparent(),
      transparent(),
      transparent(),
      ink(),
    ]);
    const root = createBranchNode([
      topLeft,
      transparent(),
      transparent(),
      bottomRight,
    ]);
    const tree = RasterQuadTree.fromSnapshot({ x: 0, y: 0, width: 4, height: 4 }, root);
    const selection = tree.connectedIslandsTouchingAreas([
      { x: 0, y: 0, width: 0.5, height: 0.5 },
      { x: 3.5, y: 3.5, width: 0.5, height: 0.5 },
    ]);

    expect(selection?.islandCount).toBe(2);
    expect(selection?.cells).toHaveLength(2);
  });

  test("connects differently sized leaves along a shared edge", () => {
    const smallerNeighbor = createBranchNode([
      ink(),
      transparent(),
      transparent(),
      transparent(),
    ]);
    const root = createBranchNode([
      ink(),
      smallerNeighbor,
      transparent(),
      transparent(),
    ]);
    const tree = RasterQuadTree.fromSnapshot({ x: 0, y: 0, width: 4, height: 4 }, root);
    const selection = tree.connectedIslandsTouching({ x: 0, y: 0, width: 1, height: 1 });

    expect(selection?.islandCount).toBe(1);
    expect(selection?.cells).toHaveLength(2);
  });

  test("selects only island components touched by a lasso polygon", () => {
    const topLeft = createBranchNode([
      ink(),
      transparent(),
      transparent(),
      transparent(),
    ]);
    const bottomRight = createBranchNode([
      transparent(),
      transparent(),
      transparent(),
      ink(),
    ]);
    const root = createBranchNode([
      topLeft,
      transparent(),
      transparent(),
      bottomRight,
    ]);
    const tree = RasterQuadTree.fromSnapshot({ x: 0, y: 0, width: 4, height: 4 }, root);
    const selection = tree.connectedIslandsTouchingPolygon([
      { x: -0.25, y: -0.25 },
      { x: 1.25, y: -0.25 },
      { x: 1.25, y: 1.25 },
      { x: -0.25, y: 1.25 },
    ]);

    expect(selection?.islandCount).toBe(1);
    expect(selection?.cells).toHaveLength(1);
  });
});
