import { RasterQuadTree } from "./quadtree";
import { loadQuadTree, saveQuadTree, type SnapshotSizes } from "./quadtree-storage";
import type { Bounds, BrushAction, Point, QuadDebugRegion, RasterCell } from "./types";
import { WORLD_BOUNDS } from "./types";

type DrawingState = {
  tree: RasterQuadTree;
  strokeCount: number;
};

const SLOW_WIDTH_FACTOR = 1.55;
const FAST_WIDTH_FACTOR = 0.55;
const MAX_WIDTH_VELOCITY = 0.9;
const INITIAL_VELOCITY_DISTANCE = 10;
const MINIMUM_POINT_DISTANCE = 0.35;
const WIDTH_GROWTH_DISTANCE = 14;
const WIDTH_SHRINK_DISTANCE = 4;
const CURVE_FLATNESS = 0.2;
const MAX_CURVE_DEPTH = 8;

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
  private persistedSnapshotSizes: SnapshotSizes = { compressedBytes: 0, uncompressedBytes: 0 };
  private readonly snapshotSizeListeners = new Set<() => void>();

  async restore(): Promise<void> {
    const restored = await loadQuadTree();
    if (!restored) return;
    this.tree = restored.tree;
    this.committedStrokeCount = restored.strokeCount;
    this.setSnapshotSizes(restored.snapshotSizes);
    if (restored.needsUpgrade) this.persist();
  }

  createStroke(point: Point, color: string, width: number): BrushAction {
    return this.createAction("stroke", point, color, width);
  }

  createEraser(point: Point, width: number): BrushAction {
    return this.createAction("eraser", point, "#000000", width);
  }

  appendPoint(action: BrushAction, point: Point): void {
    const previousPoint = action.points[action.points.length - 1];
    const movementDistance = Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
    if (action.kind === "stroke" && movementDistance < MINIMUM_POINT_DISTANCE) return;
    action.points.push(point);

    if (action.kind === "stroke" && action.points[0].strength === undefined) {
      if (initialVelocityIsReady(action)) this.paintBufferedStrokeStart(action);
      return;
    }

    if (action.kind === "stroke") {
      const targetWidth = velocityWidth(previousPoint, point, action.width);
      const responseDistance = targetWidth > previousPoint.strength!
        ? WIDTH_GROWTH_DISTANCE
        : WIDTH_SHRINK_DISTANCE;
      const response = 1 - Math.exp(-movementDistance / responseDistance);
      point.strength = previousPoint.strength! + (targetWidth - previousPoint.strength!) * response;
      this.paintReadyStrokeSegments(action, false);
      return;
    }
    this.paint(
      previousPoint,
      point,
      action,
      previousPoint.strength ?? action.width,
      point.strength ?? action.width,
    );
  }

  commit(action: BrushAction): void {
    if (!this.actionStart) return;
    if (action.kind === "stroke" && action.points[0].strength === undefined) {
      if (action.points.length === 1) {
        // A tap never produces a velocity sample, so commit a neutral-width dot.
        action.points[0].strength = action.width;
        this.paint(action.points[0], action.points[0], action, action.width, action.width);
      } else {
        this.paintBufferedStrokeStart(action);
      }
    }
    if (action.kind === "stroke" && action.points.length > 1) {
      this.paintReadyStrokeSegments(action, true);
    }
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

  get snapshotSizes(): SnapshotSizes {
    return this.persistedSnapshotSizes;
  }

  subscribeSnapshotSize(listener: () => void): () => void {
    this.snapshotSizeListeners.add(listener);
    return () => this.snapshotSizeListeners.delete(listener);
  }

  private createAction(kind: BrushAction["kind"], point: Point, color: string, width: number): BrushAction {
    if (!this.actionStart) this.actionStart = this.currentState();
    const action: BrushAction = {
      kind,
      points: [{ ...point, strength: kind === "eraser" ? width : undefined }],
      color,
      width,
      rasterizedSegments: 0,
    };
    if (kind === "eraser") this.paint(action.points[0], action.points[0], action, width, width);
    return action;
  }

  private paint(
    start: Point,
    end: Point,
    action: BrushAction,
    startWidth: number,
    endWidth: number,
  ): void {
    this.tree = this.tree.paintSegment(
      start,
      end,
      startWidth,
      endWidth,
      action.color,
      action.kind === "eraser",
    );
  }

  private paintBufferedStrokeStart(action: BrushAction): void {
    const initialWidth = bufferedVelocityWidth(action);

    // Use the look-ahead measurement for the whole startup window. Replaying
    // local startup jitter would recreate the bulb this buffer is meant to avoid.
    action.points.forEach((point) => { point.strength = initialWidth; });
    this.paintReadyStrokeSegments(action, false);
  }

  private paintReadyStrokeSegments(action: BrushAction, flushTail: boolean): void {
    const lastReadySegment = action.points.length - (flushTail ? 2 : 3);
    while (action.rasterizedSegments <= lastReadySegment) {
      this.paintCurveSegment(action, action.rasterizedSegments);
      action.rasterizedSegments += 1;
    }
  }

  private paintCurveSegment(action: BrushAction, index: number): void {
    const start = action.points[index];
    const end = action.points[index + 1];
    const startWidth = start.strength ?? action.width;
    const endWidth = end.strength ?? action.width;
    const before = index > 0 ? action.points[index - 1] : extrapolate(start, end);
    const after = index + 2 < action.points.length
      ? action.points[index + 2]
      : extrapolate(end, start);
    const beforeWidth = index > 0
      ? action.points[index - 1].strength ?? action.width
      : startWidth * 2 - endWidth;
    const afterWidth = index + 2 < action.points.length
      ? action.points[index + 2].strength ?? action.width
      : endWidth * 2 - startWidth;
    const curve = bsplineBezier(before, start, end, after);
    const curveStartWidth = (beforeWidth + startWidth * 4 + endWidth) / 6;
    const curveEndWidth = (startWidth + endWidth * 4 + afterWidth) / 6;
    const samples: CurveSample[] = [{ point: curve.start, amount: 0 }];
    flattenCubic(
      curve.start,
      curve.controlOne,
      curve.controlTwo,
      curve.end,
      0,
      1,
      samples,
      0,
    );

    for (let sampleIndex = 1; sampleIndex < samples.length; sampleIndex++) {
      const previous = samples[sampleIndex - 1];
      const current = samples[sampleIndex];
      this.paint(
        previous.point,
        current.point,
        action,
        interpolate(curveStartWidth, curveEndWidth, previous.amount),
        interpolate(curveStartWidth, curveEndWidth, current.amount),
      );
    }
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
      const snapshotSizes = await saveQuadTree(this.tree, this.committedStrokeCount);
      if (snapshotSizes !== null) this.setSnapshotSizes(snapshotSizes);
    }
    this.persistenceWriting = false;
  }

  private setSnapshotSizes(sizes: SnapshotSizes): void {
    this.persistedSnapshotSizes = sizes;
    this.snapshotSizeListeners.forEach((listener) => listener());
  }
}

type CurveSample = { point: Point; amount: number };

function bsplineBezier(
  before: Point,
  start: Point,
  end: Point,
  after: Point,
): { start: Point; controlOne: Point; controlTwo: Point; end: Point } {
  return {
    start: {
      x: (before.x + start.x * 4 + end.x) / 6,
      y: (before.y + start.y * 4 + end.y) / 6,
    },
    controlOne: {
      x: (start.x * 2 + end.x) / 3,
      y: (start.y * 2 + end.y) / 3,
    },
    controlTwo: {
      x: (start.x + end.x * 2) / 3,
      y: (start.y + end.y * 2) / 3,
    },
    end: {
      x: (start.x + end.x * 4 + after.x) / 6,
      y: (start.y + end.y * 4 + after.y) / 6,
    },
  };
}

function extrapolate(origin: Point, toward: Point): Point {
  return { x: origin.x * 2 - toward.x, y: origin.y * 2 - toward.y };
}

function flattenCubic(
  start: Point,
  controlOne: Point,
  controlTwo: Point,
  end: Point,
  startAmount: number,
  endAmount: number,
  samples: CurveSample[],
  depth: number,
): void {
  const flatness = Math.max(
    distanceToChord(controlOne, start, end),
    distanceToChord(controlTwo, start, end),
  );
  if (flatness <= CURVE_FLATNESS || depth >= MAX_CURVE_DEPTH) {
    samples.push({ point: end, amount: endAmount });
    return;
  }

  const startToOne = midpoint(start, controlOne);
  const oneToTwo = midpoint(controlOne, controlTwo);
  const twoToEnd = midpoint(controlTwo, end);
  const leftControlTwo = midpoint(startToOne, oneToTwo);
  const rightControlOne = midpoint(oneToTwo, twoToEnd);
  const split = midpoint(leftControlTwo, rightControlOne);
  const middleAmount = (startAmount + endAmount) / 2;

  flattenCubic(
    start,
    startToOne,
    leftControlTwo,
    split,
    startAmount,
    middleAmount,
    samples,
    depth + 1,
  );
  flattenCubic(
    split,
    rightControlOne,
    twoToEnd,
    end,
    middleAmount,
    endAmount,
    samples,
    depth + 1,
  );
}

function distanceToChord(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount));
}

function midpoint(first: Point, second: Point): Point {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

function interpolate(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function initialVelocityIsReady(action: BrushAction): boolean {
  let travelled = 0;
  for (let index = 1; index < action.points.length; index++) {
    travelled += Math.hypot(
      action.points[index].x - action.points[index - 1].x,
      action.points[index].y - action.points[index - 1].y,
    );
  }
  return travelled >= INITIAL_VELOCITY_DISTANCE;
}

function bufferedVelocityWidth(action: BrushAction): number {
  let strongestVelocity = 0;
  for (let index = 1; index < action.points.length; index++) {
    const previous = action.points[index - 1];
    const current = action.points[index];
    if (previous.time === undefined || current.time === undefined) continue;
    const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
    const elapsed = Math.max(current.time - previous.time, 1);
    // Ignore sub-pixel startup jitter, which is not an intentional brush motion.
    if (distance >= 0.25) strongestVelocity = Math.max(strongestVelocity, distance / elapsed);
  }
  return widthFromVelocity(strongestVelocity, action.width);
}

function velocityWidth(previous: Point, current: Point, baseWidth: number): number {
  if (previous.time === undefined || current.time === undefined) return baseWidth * SLOW_WIDTH_FACTOR;
  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  const elapsed = Math.max(current.time - previous.time, 1);
  return widthFromVelocity(distance / elapsed, baseWidth);
}

function widthFromVelocity(velocity: number, baseWidth: number): number {
  const velocityFactor = Math.min(velocity / MAX_WIDTH_VELOCITY, 1);
  const widthFactor = SLOW_WIDTH_FACTOR + velocityFactor * (FAST_WIDTH_FACTOR - SLOW_WIDTH_FACTOR);
  return baseWidth * widthFactor;
}
