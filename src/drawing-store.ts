import { RasterQuadTree } from "./quadtree";
import {
  activeLayer,
  createDrawingDocument,
  replaceLayer,
  type DrawingDocument,
  type DrawingLayer,
  type LayerId,
  type LayerInfo,
} from "./drawing-document";
import {
  loadDrawing,
  saveDrawing,
  saveLayerMetadata,
  type SnapshotSizes,
} from "./quadtree-storage";
import type {
  Bounds,
  BrushAction,
  BrushTexture,
  Point,
  QuadDebugRegion,
  RasterCell,
  RasterSelection,
  RenderCellVisitor,
} from "./types";
import { WORLD_BOUNDS } from "./types";

type DrawingState = {
  document: DrawingDocument;
  selectionShape: readonly Point[] | null;
};

const SLOW_WIDTH_FACTOR = 1.8;
const FAST_WIDTH_FACTOR = 0.35;
const MAX_WIDTH_VELOCITY = 0.9;
const LIGHT_PRESSURE_WIDTH_FACTOR = 0.2;
const HEAVY_PRESSURE_WIDTH_FACTOR = 1.8;
const INITIAL_VELOCITY_DISTANCE = 10;
const MINIMUM_POINT_DISTANCE = 0.35;
const WIDTH_GROWTH_DISTANCE = 28;
const WIDTH_SHRINK_DISTANCE = 28;
const CURVE_FLATNESS = 0.2;
const MAX_CURVE_DEPTH = 8;
const PRESSURE_SAMPLE_DELTA = 0.015;
const PRESSURE_RESPONSE_DELTA = 0.5;
const PERSISTENCE_DEBOUNCE_MS = 2_000;

/** Owns layer edits, brush transactions, history, and sparse raster trees. */
export class DrawingStore {
  private document = createDrawingDocument();
  private visualRevisionValue = 0;
  private undoStack: DrawingState[] = [];
  private redoStack: DrawingState[] = [];
  private actionStart: DrawingState | null = null;
  private actionMask: RasterQuadTree | null = null;
  private actionLayerId: LayerId | null = null;
  private actionDirtyBounds: Bounds | null = null;
  private actionBounds: Bounds | null = null;
  private selectionShapeValue: readonly Point[] | null = null;
  private persistenceQueued = false;
  private persistenceWriting = false;
  private persistencePending = false;
  private persistenceNotBefore = 0;
  private persistenceGeneration = 0;
  private occupiedResolutionQueued = false;
  private persistedSnapshotSizes: SnapshotSizes = { compressedBytes: 0, uncompressedBytes: 0 };
  private occupiedResolutionValue = { width: 0, height: 0 };
  private readonly snapshotSizeListeners = new Set<() => void>();

  async restore(): Promise<void> {
    const restored = await loadDrawing();
    if (!restored) return;
    this.document = restored.document;
    this.visualRevisionValue += 1;
    this.updateOccupiedResolution();
    this.setSnapshotSizes(restored.snapshotSizes);
  }

  createStroke(
    point: Point,
    color: string,
    width: number,
    density = 1,
    texture: BrushTexture = "solid",
    textureSeed = 0,
    dynamics = 1,
  ): BrushAction {
    return this.createAction("stroke", point, color, width, density, texture, textureSeed, dynamics);
  }

  createEraser(point: Point, width: number): BrushAction {
    return this.createAction("eraser", point, "#000000", width, 1, "solid", 0, 0);
  }

  appendPoint(action: BrushAction, point: Point): void {
    this.appendPoints(action, [point]);
  }

  /** Applies one browser input batch to the gesture mask before compositing it. */
  appendPoints(action: BrushAction, points: readonly Point[]): void {
    let painted = false;
    for (const point of points) {
      painted = this.appendPointToMask(action, point) || painted;
    }
    if (painted) this.applyActionMask(action);
  }

  private appendPointToMask(action: BrushAction, point: Point): boolean {
    const previousPoint = action.points[action.points.length - 1];
    const movementDistance = Math.hypot(point.x - previousPoint.x, point.y - previousPoint.y);
    const pressureChange = point.pressure === undefined || previousPoint.pressure === undefined
      ? 0
      : Math.abs(point.pressure - previousPoint.pressure);
    if (
      action.kind === "stroke"
      && movementDistance < MINIMUM_POINT_DISTANCE
      && pressureChange < PRESSURE_SAMPLE_DELTA
    ) return false;
    action.points.push(point);

    if (action.kind === "stroke" && action.points[0].strength === undefined) {
      return initialVelocityIsReady(action) && this.paintBufferedStrokeStart(action);
    }

    if (action.kind === "stroke") {
      const targetWidth = dynamicsAdjustedWidth(
        action.width,
        velocityWidth(previousPoint, point, action.width),
        point.pressure,
        action.dynamics,
      );
      const responseDistance = targetWidth > previousPoint.strength!
        ? WIDTH_GROWTH_DISTANCE
        : WIDTH_SHRINK_DISTANCE;
      const response = 1 - Math.exp(
        -movementDistance / responseDistance - pressureChange / PRESSURE_RESPONSE_DELTA,
      );
      point.strength = previousPoint.strength! + (targetWidth - previousPoint.strength!) * response;
      return this.paintReadyStrokeSegments(action, false);
    }
    this.paint(
      previousPoint,
      point,
      action,
      previousPoint.strength ?? action.width,
      point.strength ?? action.width,
    );
    return true;
  }

  commit(action: BrushAction): void {
    if (!this.actionStart) return;
    let painted = false;
    if (action.kind === "stroke" && action.points[0].strength === undefined) {
      if (action.points.length === 1) {
        // A tap never produces a velocity sample, so commit a neutral-width dot.
        const tapWidth = dynamicsAdjustedWidth(
          action.width,
          action.width,
          action.points[0].pressure,
          action.dynamics,
        );
        action.points[0].strength = tapWidth;
        this.paint(action.points[0], action.points[0], action, tapWidth, tapWidth);
        painted = true;
      } else {
        painted = this.paintBufferedStrokeStart(action);
      }
    }
    if (action.kind === "stroke" && action.points.length > 1) {
      painted = this.paintReadyStrokeSegments(action, true) || painted;
    }
    if (painted) this.applyActionMask(action);
    if (this.document === this.actionStart.document) {
      this.actionStart = null;
      this.actionMask = null;
      this.actionLayerId = null;
      return;
    }
    if (action.kind === "stroke") {
      this.document = replaceLayer(this.document, this.actionLayerId!, (layer) => ({
        ...layer,
        strokeCount: layer.strokeCount + 1,
      }));
    }
    this.undoStack.push(this.actionStart);
    this.redoStack = [];
    this.actionStart = null;
    this.actionMask = null;
    this.actionLayerId = null;
    this.queueOccupiedResolutionUpdate();
    this.persist();
  }

  /** Discards the active brush transaction without adding it to history. */
  cancelAction(): void {
    if (!this.actionStart) return;
    this.restoreState(this.actionStart);
  }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push(this.currentState());
    this.restoreState(previous);
    saveLayerMetadata(this.document);
    this.persist();
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.currentState());
    this.restoreState(next);
    saveLayerMetadata(this.document);
    this.persist();
    return true;
  }

  clear(): void {
    if (this.strokeCount === 0 && this.nodeCount === this.document.layers.length) {
      this.setSelection(null);
      return;
    }
    this.undoStack.push(this.currentState());
    this.redoStack = [];
    this.document = {
      ...this.document,
      layers: this.document.layers.map((layer) => ({
        ...layer,
        tree: new RasterQuadTree(WORLD_BOUNDS),
        strokeCount: 0,
      })),
    };
    this.selectionShapeValue = null;
    this.visualRevisionValue += 1;
    this.actionStart = null;
    this.actionMask = null;
    this.actionLayerId = null;
    this.updateOccupiedResolution();
    this.persist();
  }

  visibleIn(bounds: Bounds, scale = 1): RasterCell[] {
    const visible: RasterCell[] = [];
    for (const layer of this.document.layers) {
      for (const cell of cellsForLayer(layer, bounds, scale)) visible.push(cell);
    }
    return visible;
  }

  /**
   * Streams every visible layer's cells bottom-to-top into `visit` without
   * allocating cell objects. Layer opacity is folded into the alpha channel,
   * and draw order matches the layer stack, so the renderer composites with a
   * plain back-to-front pass.
   */
  visitVisible(bounds: Bounds, scale: number, visit: RenderCellVisitor): void {
    for (const layer of this.document.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      if (layer.opacity < 1) {
        const opacity = layer.opacity;
        layer.tree.visitRenderCells(bounds, scale, (x, y, width, height, color) =>
          visit(x, y, width, height, (color & 0xffffff00) | Math.round((color & 0xff) * opacity))
        );
      } else {
        layer.tree.visitRenderCells(bounds, scale, visit);
      }
    }
  }

  /** World-space bounds enclosing all ink on visible layers, or null if empty. */
  visibleOccupiedBounds(): Bounds | null {
    let result: Bounds | null = null;
    for (const layer of this.document.layers) {
      if (!layer.visible || layer.opacity <= 0) continue;
      const bounds = layer.tree.occupiedBounds();
      if (bounds) result = mergeBounds(result, bounds);
    }
    return result;
  }

  allCells(scale = 1): RasterCell[] {
    const visible: RasterCell[] = [];
    for (const layer of this.document.layers) {
      for (const cell of cellsForLayer(layer, WORLD_BOUNDS, scale)) visible.push(cell);
    }
    return visible;
  }

  /** Raster area changed since the previous live brush render. */
  consumeActionDirtyBounds(): Bounds | null {
    const dirty = this.actionDirtyBounds;
    this.actionDirtyBounds = null;
    return dirty;
  }

  /** Complete raster area touched by the active brush transaction. */
  get activeActionBounds(): Bounds | null {
    return this.actionBounds;
  }

  selectConnectedIslands(area: Bounds): RasterSelection | null {
    return this.selectConnectedIslandsFromLayer((tree) => tree.connectedIslandsTouching(area));
  }

  selectConnectedIslandsInPolygon(points: readonly Point[]): RasterSelection | null {
    return this.selectConnectedIslandsFromLayer(
      (tree) => tree.connectedIslandsTouchingPolygon(points),
    );
  }

  private selectConnectedIslandsFromLayer(
    select: (tree: RasterQuadTree) => RasterSelection | null,
  ): RasterSelection | null {
    const activeIndex = this.document.layers.findIndex(
      ({ id }) => id === this.document.activeLayerId,
    );
    const layerIndexes: number[] = [];
    for (let index = activeIndex; index >= 0; index -= 1) layerIndexes.push(index);
    for (let index = activeIndex + 1; index < this.document.layers.length; index += 1) {
      layerIndexes.push(index);
    }
    for (const index of layerIndexes) {
      const layer = this.document.layers[index];
      const selection = select(layer.tree);
      if (!selection) continue;
      if (layer.id !== this.document.activeLayerId) this.setActiveLayer(layer.id);
      return selection;
    }
    return null;
  }

  /** The active selection shape, or null. Also clips subsequent brush and eraser strokes. */
  get selectionShape(): readonly Point[] | null {
    return this.selectionShapeValue;
  }

  /**
   * Replaces the active selection shape (or clears it with `null`), as its own
   * undoable step — so deselecting can be undone back to the prior selection.
   */
  setSelection(points: readonly Point[] | null): void {
    const normalized = points && points.length >= 3 ? points : null;
    if (normalized === this.selectionShapeValue) return;
    this.undoStack.push(this.currentState());
    this.redoStack = [];
    this.selectionShapeValue = normalized;
  }

  snapSelectionMovement(selection: RasterSelection, x: number, y: number): Point {
    const minimumX = WORLD_BOUNDS.x - selection.bounds.x;
    const maximumX = WORLD_BOUNDS.x + WORLD_BOUNDS.width
      - selection.bounds.x - selection.bounds.width;
    const minimumY = WORLD_BOUNDS.y - selection.bounds.y;
    const maximumY = WORLD_BOUNDS.y + WORLD_BOUNDS.height
      - selection.bounds.y - selection.bounds.height;
    return this.tree.snapTranslation(
      Math.min(maximumX, Math.max(minimumX, x)),
      Math.min(maximumY, Math.max(minimumY, y)),
    );
  }

  /** Moves the selected cells and clears the selection, as one undoable step. */
  moveSelection(selection: RasterSelection, x: number, y: number): RasterSelection | null {
    const offset = this.snapSelectionMovement(selection, x, y);
    if (offset.x === 0 && offset.y === 0) {
      this.setSelection(null);
      return selection;
    }
    const moved = this.tree.moveSelection(selection, offset.x, offset.y);
    if (moved.tree === this.tree) {
      this.setSelection(null);
      return selection;
    }

    this.undoStack.push(this.currentState());
    this.redoStack = [];
    this.tree = moved.tree;
    this.selectionShapeValue = null;
    this.queueOccupiedResolutionUpdate();
    this.persist();

    return moved.selection;
  }

  /** Adds a new topmost layer and makes it active. */
  addLayer(name = `Layer ${this.document.nextLayerId}`): LayerId {
    this.assertNoActiveAction();
    const id = this.document.nextLayerId;
    const layer: DrawingLayer = {
      id,
      name,
      visible: true,
      opacity: 1,
      tree: new RasterQuadTree(WORLD_BOUNDS),
      strokeCount: 0,
    };
    this.commitDocumentChange({
      layers: [...this.document.layers, layer],
      activeLayerId: id,
      nextLayerId: id + 1,
    });
    return id;
  }

  /** Selects the layer that receives drawing, erasing, and selection edits. */
  setActiveLayer(layerId: LayerId): boolean {
    this.assertNoActiveAction();
    if (layerId === this.document.activeLayerId) return false;
    if (!this.document.layers.some(({ id }) => id === layerId)) return false;
    this.document = { ...this.document, activeLayerId: layerId };
    this.persistLayerChange();
    return true;
  }

  renameLayer(layerId: LayerId, name: string): boolean {
    const normalized = name.trim();
    if (!normalized) return false;
    return this.updateLayer(layerId, (layer) => (
      layer.name === normalized ? layer : { ...layer, name: normalized }
    ));
  }

  setLayerVisibility(layerId: LayerId, visible: boolean): boolean {
    return this.updateLayer(layerId, (layer) => (
      layer.visible === visible ? layer : { ...layer, visible }
    ));
  }

  setLayerOpacity(layerId: LayerId, opacity: number): boolean {
    if (!Number.isFinite(opacity)) return false;
    const normalized = Math.max(0, Math.min(1, opacity));
    return this.updateLayer(layerId, (layer) => (
      layer.opacity === normalized ? layer : { ...layer, opacity: normalized }
    ));
  }

  /** Moves a layer to a bottom-to-top array index. */
  moveLayer(layerId: LayerId, index: number): boolean {
    this.assertNoActiveAction();
    if (!Number.isFinite(index)) return false;
    const currentIndex = this.document.layers.findIndex(({ id }) => id === layerId);
    if (currentIndex < 0) return false;
    const nextIndex = Math.max(0, Math.min(this.document.layers.length - 1, Math.trunc(index)));
    if (currentIndex === nextIndex) return false;
    const layers = [...this.document.layers];
    const [layer] = layers.splice(currentIndex, 1);
    layers.splice(nextIndex, 0, layer);
    this.commitDocumentChange({ ...this.document, layers });
    return true;
  }

  /** Removes a layer while guaranteeing that every document retains one layer. */
  removeLayer(layerId: LayerId): boolean {
    this.assertNoActiveAction();
    if (this.document.layers.length === 1) return false;
    const index = this.document.layers.findIndex(({ id }) => id === layerId);
    if (index < 0) return false;
    const layers = this.document.layers.filter(({ id }) => id !== layerId);
    const activeLayerId = this.document.activeLayerId === layerId
      ? layers[Math.min(index, layers.length - 1)].id
      : this.document.activeLayerId;
    this.commitDocumentChange({ ...this.document, layers, activeLayerId });
    return true;
  }

  debugLeavesIn(bounds: Bounds, scale = 1): QuadDebugRegion[] {
    return this.tree.debugLeavesIn(bounds, scale);
  }

  get strokeCount(): number {
    return this.document.layers.reduce((count, layer) => count + layer.strokeCount, 0);
  }

  /** Changes whenever cached composited raster output may have become stale. */
  get visualRevision(): number {
    return this.visualRevisionValue;
  }

  get nodeCount(): number {
    return this.document.layers.reduce((count, layer) => count + layer.tree.countNodes(), 0);
  }

  get layers(): readonly LayerInfo[] {
    return this.document.layers.map(({ tree: _tree, ...info }) => info);
  }

  get activeLayerId(): LayerId {
    return this.document.activeLayerId;
  }

  get occupiedResolution(): Readonly<{ width: number; height: number }> {
    return this.occupiedResolutionValue;
  }

  get snapshotSizes(): SnapshotSizes {
    return this.persistedSnapshotSizes;
  }

  subscribeSnapshotSize(listener: () => void): () => void {
    this.snapshotSizeListeners.add(listener);
    return () => this.snapshotSizeListeners.delete(listener);
  }

  private createAction(
    kind: BrushAction["kind"],
    point: Point,
    color: string,
    width: number,
    density: number,
    texture: BrushTexture,
    textureSeed: number,
    dynamics: number,
  ): BrushAction {
    // If a debounced snapshot is waiting, keep it out of the input-critical
    // part of the next gesture. The write will resume after drawing is quiet.
    this.persistenceNotBefore = Math.max(
      this.persistenceNotBefore,
      Date.now() + PERSISTENCE_DEBOUNCE_MS,
    );
    if (!this.actionStart) {
      // Cancel an older full-tree snapshot before it can compete with this
      // gesture. Its replacement is queued after the gesture settles.
      this.persistenceGeneration += 1;
      if (this.persistenceWriting) this.persistencePending = true;
      this.actionStart = this.currentState();
      this.actionMask = new RasterQuadTree(WORLD_BOUNDS);
      this.actionLayerId = this.document.activeLayerId;
      this.actionDirtyBounds = null;
      this.actionBounds = null;
    }
    const action: BrushAction = {
      kind,
      points: [{ ...point, strength: kind === "eraser" ? width : undefined }],
      color,
      width,
      dynamics: Math.max(0, Math.min(1, dynamics)),
      density: Math.max(0, Math.min(1, density)),
      texture,
      textureSeed,
      textureOffset: 0,
      rasterizedSegments: 0,
    };
    if (kind === "eraser") {
      this.paint(action.points[0], action.points[0], action, width, width);
      this.applyActionMask(action);
    }
    return action;
  }

  private paint(
    start: Point,
    end: Point,
    action: BrushAction,
    startWidth: number,
    endWidth: number,
    startDensity = densityForPoint(action, start),
    endDensity = densityForPoint(action, end),
  ): void {
    if (!this.actionStart || !this.actionMask) return;
    const nextMask = this.actionMask.paintSegment(
      start,
      end,
      startWidth,
      endWidth,
      "#000000",
      false,
      startDensity,
      action.texture,
      action.textureSeed,
      endDensity,
      action.textureOffset,
      action.width,
    );
    action.textureOffset += Math.hypot(end.x - start.x, end.y - start.y);
    if (nextMask !== this.actionMask) {
      const paintedBounds = brushSegmentBounds(
        start,
        end,
        startWidth,
        endWidth,
        action.texture,
      );
      this.actionDirtyBounds = mergeBounds(this.actionDirtyBounds, paintedBounds);
      this.actionBounds = mergeBounds(this.actionBounds, paintedBounds);
    }
    this.actionMask = nextMask;
  }

  private applyActionMask(action: BrushAction): void {
    if (!this.actionStart || !this.actionMask || this.actionLayerId === null) return;
    const baseLayer = this.actionStart.document.layers.find(({ id }) => id === this.actionLayerId);
    const previousLayer = this.document.layers.find(({ id }) => id === this.actionLayerId);
    if (!baseLayer || !previousLayer || !this.actionDirtyBounds) return;
    const mask = this.selectionShapeValue
      ? this.actionMask.clipToPolygon(this.selectionShapeValue)
      : this.actionMask;
    const tree = baseLayer.tree.applyMaskRegion(
      mask,
      action.color,
      action.kind === "eraser",
      this.actionDirtyBounds,
      previousLayer.tree,
    );
    const nextDocument = replaceLayer(this.actionStart.document, this.actionLayerId, (layer) => (
      tree === layer.tree ? layer : { ...layer, tree }
    ));
    if (nextDocument !== this.document) {
      this.document = nextDocument;
      this.visualRevisionValue += 1;
    }
  }

  private paintBufferedStrokeStart(action: BrushAction): boolean {
    const initialWidth = bufferedVelocityWidth(action);

    // Use the look-ahead measurement for the whole startup window. Replaying
    // local startup jitter would recreate the bulb this buffer is meant to avoid.
    action.points.forEach((point) => {
      point.strength = dynamicsAdjustedWidth(
        action.width,
        initialWidth,
        point.pressure,
        action.dynamics,
      );
    });
    return this.paintReadyStrokeSegments(action, false);
  }

  private paintReadyStrokeSegments(action: BrushAction, flushTail: boolean): boolean {
    const lastReadySegment = action.points.length - (flushTail ? 2 : 3);
    let painted = false;
    while (action.rasterizedSegments <= lastReadySegment) {
      this.paintCurveSegment(action, action.rasterizedSegments);
      action.rasterizedSegments += 1;
      painted = true;
    }
    return painted;
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
    const startDensity = densityForPoint(action, start);
    const endDensity = densityForPoint(action, end);
    const beforeDensity = index > 0
      ? densityForPoint(action, action.points[index - 1])
      : startDensity * 2 - endDensity;
    const afterDensity = index + 2 < action.points.length
      ? densityForPoint(action, action.points[index + 2])
      : endDensity * 2 - startDensity;
    const curveStartDensity = (beforeDensity + startDensity * 4 + endDensity) / 6;
    const curveEndDensity = (startDensity + endDensity * 4 + afterDensity) / 6;
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
        interpolate(curveStartDensity, curveEndDensity, previous.amount),
        interpolate(curveStartDensity, curveEndDensity, current.amount),
      );
    }
  }

  private currentState(): DrawingState {
    return { document: this.document, selectionShape: this.selectionShapeValue };
  }

  private restoreState(state: DrawingState): void {
    this.document = state.document;
    this.selectionShapeValue = state.selectionShape;
    this.visualRevisionValue += 1;
    this.actionStart = null;
    this.actionMask = null;
    this.actionLayerId = null;
    this.actionDirtyBounds = null;
    this.actionBounds = null;
    this.updateOccupiedResolution();
  }

  private updateOccupiedResolution(): void {
    const occupied = this.document.layers
      .filter(({ visible, opacity }) => visible && opacity > 0)
      .map(({ tree }) => tree.occupiedBounds())
      .filter((bounds): bounds is Bounds => bounds !== null);
    if (occupied.length === 0) {
      this.occupiedResolutionValue = { width: 0, height: 0 };
      return;
    }
    const minimumX = Math.min(...occupied.map(({ x }) => x));
    const minimumY = Math.min(...occupied.map(({ y }) => y));
    const maximumX = Math.max(...occupied.map(({ x, width }) => x + width));
    const maximumY = Math.max(...occupied.map(({ y, height }) => y + height));
    const maximumResolution = 2 ** 15;
    this.occupiedResolutionValue = {
      width: Math.round((maximumX - minimumX) / WORLD_BOUNDS.width * maximumResolution),
      height: Math.round((maximumY - minimumY) / WORLD_BOUNDS.height * maximumResolution),
    };
  }

  private queueOccupiedResolutionUpdate(): void {
    if (this.occupiedResolutionQueued) return;
    this.occupiedResolutionQueued = true;
    const update = () => {
      this.occupiedResolutionQueued = false;
      this.updateOccupiedResolution();
      this.snapshotSizeListeners.forEach((listener) => listener());
    };
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(update, { timeout: 1_000 });
    } else {
      globalThis.setTimeout(update, 0);
    }
  }

  private persist(): void {
    this.persistenceGeneration += 1;
    this.persistencePending = true;
    this.persistenceNotBefore = Date.now() + PERSISTENCE_DEBOUNCE_MS;
    if (this.persistenceQueued || this.persistenceWriting) return;

    this.persistenceQueued = true;
    const writeWhenQuiet = () => {
      const delay = this.persistenceNotBefore - Date.now();
      if (delay > 0) {
        globalThis.setTimeout(writeWhenQuiet, delay);
        return;
      }
      void this.flushPersistence();
    };
    if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(writeWhenQuiet, { timeout: 1_000 });
    } else {
      globalThis.setTimeout(writeWhenQuiet, 0);
    }
  }

  private async flushPersistence(): Promise<void> {
    this.persistenceQueued = false;
    if (this.persistenceWriting) return;
    this.persistenceWriting = true;
    this.persistencePending = false;
    const generation = this.persistenceGeneration;
    const snapshotSizes = await saveDrawing(
      this.document,
      () => generation === this.persistenceGeneration && this.actionStart === null,
    );
    if (snapshotSizes !== null) this.setSnapshotSizes(snapshotSizes);
    this.persistenceWriting = false;
    if (this.persistencePending) this.persist();
  }

  private setSnapshotSizes(sizes: SnapshotSizes): void {
    this.persistedSnapshotSizes = sizes;
    this.snapshotSizeListeners.forEach((listener) => listener());
  }

  private get tree(): RasterQuadTree {
    return activeLayer(this.document).tree;
  }

  private set tree(tree: RasterQuadTree) {
    const nextDocument = replaceLayer(this.document, this.document.activeLayerId, (layer) => (
      tree === layer.tree ? layer : { ...layer, tree }
    ));
    if (nextDocument !== this.document) {
      this.document = nextDocument;
      this.visualRevisionValue += 1;
    }
  }

  private updateLayer(
    layerId: LayerId,
    update: (layer: DrawingLayer) => DrawingLayer,
  ): boolean {
    this.assertNoActiveAction();
    if (!this.document.layers.some(({ id }) => id === layerId)) return false;
    const next = replaceLayer(this.document, layerId, update);
    if (next === this.document) return false;
    this.commitDocumentChange(next);
    return true;
  }

  private commitDocumentChange(document: DrawingDocument): void {
    this.undoStack.push(this.currentState());
    this.redoStack = [];
    this.document = document;
    this.visualRevisionValue += 1;
    this.updateOccupiedResolution();
    this.persistLayerChange();
  }

  private persistLayerChange(): void {
    saveLayerMetadata(this.document);
    this.persist();
  }

  private assertNoActiveAction(): void {
    if (this.actionStart) throw new Error("Cannot change layers during a brush action");
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

function dynamicsAdjustedWidth(
  baseWidth: number,
  velocityWidth: number,
  pressure: number | undefined,
  dynamics: number,
): number {
  const pressureFactor = pressure === undefined
    ? 1
    : interpolate(
      LIGHT_PRESSURE_WIDTH_FACTOR,
      HEAVY_PRESSURE_WIDTH_FACTOR,
      Math.max(0, Math.min(1, pressure)),
    );
  return interpolate(baseWidth, velocityWidth * pressureFactor, dynamics);
}

function densityForPoint(action: BrushAction, point: Point): number {
  if (action.kind === "eraser" || point.pressure === undefined) return action.density;
  const pressure = Math.max(0, Math.min(1, point.pressure));
  return action.density * (0.08 + pressure * 0.92);
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

function velocityWidth(
  previous: Point,
  current: Point,
  baseWidth: number,
): number {
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

function brushSegmentBounds(
  start: Point,
  end: Point,
  startWidth: number,
  endWidth: number,
  texture: BrushTexture,
): Bounds {
  // Includes the masked brush edge and the finest raster edge pixel.
  const width = Math.max(startWidth, endWidth);
  // Bristle tip stamps are slightly elongated and can turn, so allow more than
  // the circular brush radius without repainting an excessively large region.
  const outset = texture === "bristle" ? width * 0.85 + 2 : width * 0.75 + 2;
  const x = Math.min(start.x, end.x) - outset;
  const y = Math.min(start.y, end.y) - outset;
  return {
    x,
    y,
    width: Math.max(start.x, end.x) + outset - x,
    height: Math.max(start.y, end.y) + outset - y,
  };
}

function mergeBounds(current: Bounds | null, next: Bounds): Bounds {
  if (!current) return next;
  const x = Math.min(current.x, next.x);
  const y = Math.min(current.y, next.y);
  const right = Math.max(current.x + current.width, next.x + next.width);
  const bottom = Math.max(current.y + current.height, next.y + next.height);
  return { x, y, width: right - x, height: bottom - y };
}

function cellsForLayer(layer: DrawingLayer, bounds: Bounds, scale: number): RasterCell[] {
  if (!layer.visible || layer.opacity <= 0) return [];
  const cells = layer.tree.cellsForRendering(bounds, scale);
  for (const cell of cells) {
    if (layer.opacity < 1) {
      cell.color = (cell.color & 0xffffff00) | Math.round((cell.color & 0xff) * layer.opacity);
    }
    cell.renderGroup = layer.id;
  }
  return cells;
}
