import { RasterQuadTree } from "./quadtree";
import { loadQuadTree, saveQuadTree } from "./quadtree-storage";
import type { Bounds, BrushAction, Point, QuadDebugRegion, RasterCell } from "./types";
import { WORLD_BOUNDS } from "./types";

type DrawingState = {
  tree: RasterQuadTree;
  strokeCount: number;
};

const SLOW_WIDTH_FACTOR = 0.55;
const FAST_WIDTH_FACTOR = 1.55;
const WIDTH_RESPONSE = 0.4;
const MAX_WIDTH_VELOCITY = 0.9;

/** Owns brush transactions, history, and the sparse raster quadtree. */
export class DrawingStore {
  private tree = new RasterQuadTree(WORLD_BOUNDS);
  private committedStrokeCount = 0;
  private undoStack: DrawingState[] = [];
  private redoStack: DrawingState[] = [];
  private actionStart: DrawingState | null = null;
  private persistenceQueued = false;
  private persistenceWriting = false;
  private persistencePending = false;

  async restore(): Promise<void> {
    const restored = await loadQuadTree();
    if (!restored) return;
    this.tree = restored.tree;
    this.committedStrokeCount = restored.strokeCount;
  }

  createStroke(point: Point, color: string, width: number): BrushAction {
    return this.createAction("stroke", point, color, width);
  }

  createEraser(point: Point, width: number): BrushAction {
    return this.createAction("eraser", point, "#000000", width);
  }

  appendPoint(action: BrushAction, point: Point): void {
    const previousPoint = action.points.at(-1)!;
    if (action.kind === "stroke") {
      const targetWidth = velocityWidth(previousPoint, point, action.width);
      const previousWidth = previousPoint.strength ?? action.width;
      point.strength = previousWidth + (targetWidth - previousWidth) * WIDTH_RESPONSE;
    }
    action.points.push(point);
    this.paint(previousPoint, point, action, ((previousPoint.strength ?? action.width) + (point.strength ?? action.width)) / 2);
  }

  commit(action: BrushAction): void {
    if (!this.actionStart) return;
    if (this.tree === this.actionStart.tree) {
      this.actionStart = null;
      return;
    }
    this.undoStack.push(this.actionStart);
    this.redoStack = [];
    this.actionStart = null;
    if (action.kind === "stroke") this.committedStrokeCount += 1;
    this.persist();
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.currentState());
    this.restoreState(previous);
    this.persist();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.currentState());
    this.restoreState(next);
    this.persist();
    return true;
  }

  clear(): void {
    if (this.committedStrokeCount === 0 && this.tree.countNodes() === 1) return;
    this.undoStack.push(this.currentState());
    this.redoStack = [];
    this.tree = new RasterQuadTree(WORLD_BOUNDS);
    this.committedStrokeCount = 0;
    this.actionStart = null;
    this.persist();
  }

  visibleIn(bounds: Bounds): RasterCell[] {
    return this.tree.cellsIn(bounds);
  }

  allCells(): RasterCell[] {
    return this.tree.allCells();
  }

  debugLeavesIn(bounds: Bounds): QuadDebugRegion[] {
    return this.tree.debugLeavesIn(bounds);
  }

  get strokeCount(): number {
    return this.committedStrokeCount;
  }

  get nodeCount(): number {
    return this.tree.countNodes();
  }

  private createAction(kind: BrushAction["kind"], point: Point, color: string, width: number): BrushAction {
    if (!this.actionStart) this.actionStart = this.currentState();
    const action: BrushAction = {
      kind,
      points: [{ ...point, strength: kind === "stroke" ? width * SLOW_WIDTH_FACTOR : width }],
      color,
      width,
    };
    this.paint(action.points[0], action.points[0], action, width);
    return action;
  }

  private paint(start: Point, end: Point, action: BrushAction, width: number): void {
    this.tree = this.tree.paintSegment(start, end, width, action.color, action.kind === "eraser");
  }

  private currentState(): DrawingState {
    return { tree: this.tree, strokeCount: this.committedStrokeCount };
  }

  private restoreState(state: DrawingState): void {
    this.tree = state.tree;
    this.committedStrokeCount = state.strokeCount;
    this.actionStart = null;
  }

  private persist(): void {
    this.persistencePending = true;
    if (this.persistenceQueued || this.persistenceWriting) return;

    this.persistenceQueued = true;
    const writeTree = () => void this.flushPersistence();
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(writeTree, { timeout: 1_000 });
    else globalThis.setTimeout(writeTree, 0);
  }

  private async flushPersistence(): Promise<void> {
    this.persistenceQueued = false;
    this.persistenceWriting = true;
    while (this.persistencePending) {
      this.persistencePending = false;
      await saveQuadTree(this.tree, this.committedStrokeCount);
    }
    this.persistenceWriting = false;
  }
}

function velocityWidth(previous: Point, current: Point, baseWidth: number): number {
  if (previous.time === undefined || current.time === undefined) return baseWidth * SLOW_WIDTH_FACTOR;
  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  const elapsed = Math.max(current.time - previous.time, 1);
  const velocityFactor = Math.min((distance / elapsed) / MAX_WIDTH_VELOCITY, 1);
  const widthFactor = SLOW_WIDTH_FACTOR + velocityFactor * (FAST_WIDTH_FACTOR - SLOW_WIDTH_FACTOR);
  return baseWidth * widthFactor;
}
