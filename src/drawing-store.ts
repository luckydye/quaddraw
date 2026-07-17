import { QuadTree } from "./quadtree";
import { loadQuadTree, saveQuadTree } from "./quadtree-storage";
import { freezeStrokeGeometry } from "./stroke-geometry";
import { boundsAround, boundsFromPoints, type Bounds, type Point, type Stroke, WORLD_BOUNDS } from "./types";

/** Owns drawing operations, history, and the quadtree spatial index. */
export class DrawingStore {
  private paths: Stroke[] = [];
  private undoStack: Stroke[][] = [];
  private redoStack: Stroke[][] = [];
  private index = this.createIndex();
  private nextPathId = 1;
  private persistenceQueued = false;
  private persistenceWriting = false;
  private persistencePending = false;

  async restore(): Promise<void> {
    const restoredIndex = await loadQuadTree();
    if (!restoredIndex) {
      return;
    }

    this.index = restoredIndex;
    this.paths = restoredIndex.allItems().sort((first, second) => first.id - second.id);
    this.paths.forEach((path) => {
      if (!path.segments) freezeStrokeGeometry(path);
    });
    this.nextPathId = Math.max(0, ...this.paths.map((path) => path.id)) + 1;
    this.persist();
  }

  createStroke(point: Point, color: string, width: number): Stroke {
    return this.createPath("stroke", point, color, width, 0.28);
  }

  createEraser(point: Point, width: number): Stroke {
    return this.createPath("eraser", point, "#000000", width, 0);
  }

  appendPoint(path: Stroke, point: Point): void {
    const previousPoint = path.points.at(-1)!;
    if (path.kind === "stroke") {
      const targetWidth = velocityWidth(previousPoint, point, path.width);
      const previousWidth = previousPoint.strength ?? path.width;
      point.strength = previousWidth + (targetWidth - previousWidth) * 0.3;
    }
    path.points.push(point);
    path.segments = undefined;
    path.bounds = boundsFromPoints(path.points, path.width);
  }

  commit(path: Stroke): void {
    if (path.points.length === 1) {
      path.points.push({ x: path.points[0].x + 0.1, y: path.points[0].y });
    }

    path.bounds = boundsFromPoints(path.points, path.width);
    freezeStrokeGeometry(path);
    this.saveForUndo();
    this.paths.push(path);
    this.index.insert(path);
    this.persist();
  }

  undo(): boolean {
    const previousPaths = this.undoStack.pop();
    if (!previousPaths) {
      return false;
    }

    this.redoStack.push([...this.paths]);
    this.paths = previousPaths;
    this.rebuildIndex();
    this.persist();
    return true;
  }

  redo(): boolean {
    const nextPaths = this.redoStack.pop();
    if (!nextPaths) {
      return false;
    }

    this.undoStack.push([...this.paths]);
    this.paths = nextPaths;
    this.rebuildIndex();
    this.persist();
    return true;
  }

  clear(): void {
    if (this.paths.length === 0) {
      return;
    }

    this.saveForUndo();
    this.paths = [];
    this.index = this.createIndex();
    this.persist();
  }

  visibleIn(bounds: Bounds): Stroke[] {
    // Tree traversal is spatial, not chronological; replay paths by creation
    // order so an eraser only affects ink that was drawn before it.
    return this.index.query(bounds).sort((first, second) => first.id - second.id);
  }

  all(): readonly Stroke[] {
    return this.paths;
  }

  get strokeCount(): number {
    return this.paths.filter((path) => path.kind === "stroke").length;
  }

  get nodeCount(): number {
    return this.index.countNodes();
  }

  private createPath(
    kind: Stroke["kind"],
    point: Point,
    color: string,
    width: number,
    softness: number,
  ): Stroke {
    return {
      id: this.nextPathId++,
      kind,
      points: [{ ...point, strength: width }],
      color,
      width,
      softness,
      bounds: boundsAround(point, 1),
    };
  }

  private saveForUndo(): void {
    this.undoStack.push([...this.paths]);
    this.redoStack = [];
  }

  private rebuildIndex(): void {
    this.index = this.createIndex();
    this.paths.forEach((path) => this.index.insert(path));
  }

  private createIndex(): QuadTree<Stroke> {
    return new QuadTree<Stroke>(WORLD_BOUNDS);
  }

  private persist(): void {
    this.persistencePending = true;
    if (this.persistenceQueued || this.persistenceWriting) {
      return;
    }

    this.persistenceQueued = true;
    const writeTree = () => void this.flushPersistence();

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(writeTree, { timeout: 1_000 });
    } else {
      window.setTimeout(writeTree, 0);
    }
  }

  private async flushPersistence(): Promise<void> {
    this.persistenceQueued = false;
    this.persistenceWriting = true;

    while (this.persistencePending) {
      this.persistencePending = false;
      await saveQuadTree(this.index);
    }

    this.persistenceWriting = false;
  }
}

function velocityWidth(previous: Point, current: Point, baseWidth: number): number {
  if (previous.time === undefined || current.time === undefined) {
    return baseWidth;
  }

  const distance = Math.hypot(current.x - previous.x, current.y - previous.y);
  const elapsed = Math.max(current.time - previous.time, 1);
  const velocityFactor = Math.min((distance / elapsed) / 1.1, 1);
  return baseWidth * (1.4 - velocityFactor * 0.7);
}
