import { rgbaToCss } from "./quadtree";
import {
  PACKED_CELL_BYTES,
  PACKED_DEBUG_REGION_FLOATS,
  type WorkerRenderRequest,
  type WorkerRenderResult,
} from "./render-worker-protocol";
import { createRenderWorker } from "./render-worker";
import { WORLD_BOUNDS } from "./types";
import type {
  Bounds,
  Camera,
  Point,
  QuadDebugRegion,
  RasterCell,
  RasterSelection,
} from "./types";

const MINIMAP_SCALE = 0.012;
const OVERVIEW_SCALE = 0.08;
const CACHE_MARGIN_FACTOR = 0.2;
const SELECTION_HIGHLIGHT_CELL_LIMIT = 20_000;

/** Renders colored quadtree regions without reconstructing vector paths. */
export class CanvasRenderer {
  readonly overviewScale = OVERVIEW_SCALE;
  private readonly context: CanvasRenderingContext2D;
  private readonly overviewCanvas = document.createElement("canvas");
  private readonly overviewContext: CanvasRenderingContext2D;
  private readonly committedTreeCanvas = document.createElement("canvas");
  private readonly committedTreeContext: CanvasRenderingContext2D;
  private readonly treeCanvas = document.createElement("canvas");
  private readonly treeContext: CanvasRenderingContext2D;
  private readonly selectionMaskCanvas = document.createElement("canvas");
  private readonly selectionMaskContext: CanvasRenderingContext2D;
  private readonly selectionPreviewCanvas = document.createElement("canvas");
  private readonly selectionPreviewContext: CanvasRenderingContext2D;
  private readonly minimapContext: CanvasRenderingContext2D;
  private committedCamera: Camera = { x: 0, y: 0, zoom: 1 };
  private committedWorldBounds: Bounds | null = null;
  private cacheMarginX = 0;
  private cacheMarginY = 0;
  private cacheWidth = 0;
  private cacheHeight = 0;
  private pixelScale = 1;
  private canvasLeft = 0;
  private canvasTop = 0;
  private renderWorker: Worker | null = null;
  private renderRequestId = 0;
  private pathSelection: RasterSelection | null = null;
  private pathSelectionValue: Path2D | null = null;
  private previewSelection: RasterSelection | null = null;
  private previewCamera: Camera | null = null;
  private pendingWorkerRender: {
    id: number;
    camera: Camera;
    worldBounds: Bounds;
    onReady: () => void;
    onFailure: () => void;
  } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly minimap: HTMLCanvasElement,
    private readonly area: HTMLElement,
  ) {
    this.context = canvas.getContext("2d")!;
    this.overviewContext = this.overviewCanvas.getContext("2d")!;
    this.committedTreeContext = this.committedTreeCanvas.getContext("2d")!;
    this.treeContext = this.treeCanvas.getContext("2d")!;
    this.selectionMaskContext = this.selectionMaskCanvas.getContext("2d")!;
    this.selectionPreviewContext = this.selectionPreviewCanvas.getContext("2d")!;
    this.minimapContext = minimap.getContext("2d")!;
    this.overviewCanvas.width = Math.ceil(WORLD_BOUNDS.width * OVERVIEW_SCALE);
    this.overviewCanvas.height = Math.ceil(WORLD_BOUNDS.height * OVERVIEW_SCALE);
    this.initializeRenderWorker();
  }

  resize(): void {
    const bounds = this.area.getBoundingClientRect();
    const scale = window.devicePixelRatio;
    this.canvasLeft = bounds.left;
    this.canvasTop = bounds.top;
    this.pixelScale = scale;
    this.canvas.width = bounds.width * scale;
    this.canvas.height = bounds.height * scale;
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.cacheMarginX = bounds.width * CACHE_MARGIN_FACTOR;
    this.cacheMarginY = bounds.height * CACHE_MARGIN_FACTOR;
    this.cacheWidth = bounds.width + this.cacheMarginX * 2;
    this.cacheHeight = bounds.height + this.cacheMarginY * 2;
    this.committedTreeCanvas.width = this.cacheWidth * scale;
    this.committedTreeCanvas.height = this.cacheHeight * scale;
    this.committedTreeContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.treeCanvas.width = bounds.width * scale;
    this.treeCanvas.height = bounds.height * scale;
    this.treeContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.selectionMaskCanvas.width = this.treeCanvas.width;
    this.selectionMaskCanvas.height = this.treeCanvas.height;
    this.selectionPreviewCanvas.width = this.treeCanvas.width;
    this.selectionPreviewCanvas.height = this.treeCanvas.height;
    this.previewSelection = null;
    this.previewCamera = null;
    this.committedWorldBounds = null;
    this.renderRequestId += 1;
    this.pendingWorkerRender = null;
  }

  screenToWorld(event: PointerEvent, camera: Camera): Point {
    return {
      x: (event.clientX - this.canvasLeft - camera.x) / camera.zoom,
      y: (event.clientY - this.canvasTop - camera.y) / camera.zoom,
      time: event.timeStamp,
      pressure: event.pointerType === "pen" ? event.pressure : undefined,
    };
  }

  render(
    camera: Camera,
    cells: readonly RasterCell[],
    debugRegions: readonly QuadDebugRegion[],
    redrawTree: boolean,
    renderedWorldBounds: Bounds | null,
    selection: RasterSelection | null = null,
    marquee: Bounds | null = null,
    selectionOffset: Point = { x: 0, y: 0 },
  ): void {
    const viewport = this.area.getBoundingClientRect();
    if (redrawTree) {
      this.previewSelection = null;
      this.previewCamera = null;
      this.renderRequestId += 1;
      this.pendingWorkerRender = null;
      this.committedTreeContext.clearRect(0, 0, this.cacheWidth, this.cacheHeight);
      this.committedTreeContext.save();
      this.committedTreeContext.translate(camera.x + this.cacheMarginX, camera.y + this.cacheMarginY);
      this.committedTreeContext.scale(camera.zoom, camera.zoom);
      this.drawCells(cells, this.committedTreeContext);
      this.drawDebugRegions(debugRegions, this.committedTreeContext, camera.zoom);
      this.committedTreeContext.restore();
      this.committedCamera = { ...camera };
      this.committedWorldBounds = renderedWorldBounds ?? this.renderBounds(camera);
    }

    this.treeContext.clearRect(0, 0, viewport.width, viewport.height);
    this.drawTreeForCamera(viewport, camera);
    this.context.clearRect(0, 0, viewport.width, viewport.height);
    this.context.drawImage(this.treeCanvas, 0, 0, viewport.width, viewport.height);
    this.drawSelection(viewport, camera, selection, marquee, selectionOffset);
  }

  /** Queues a committed-cache rasterization without blocking the UI thread. */
  renderTreeOffThread(
    camera: Camera,
    cells: readonly RasterCell[],
    debugRegions: readonly QuadDebugRegion[],
    renderedWorldBounds: Bounds,
    onReady: () => void,
  ): boolean {
    if (!this.renderWorker) return false;

    const id = ++this.renderRequestId;
    const cellsBuffer = packCells(cells);
    const debugBuffer = packDebugRegions(debugRegions);
    const request: WorkerRenderRequest = {
      type: "render",
      id,
      width: this.committedTreeCanvas.width,
      height: this.committedTreeCanvas.height,
      pixelScale: this.pixelScale,
      cameraX: camera.x,
      cameraY: camera.y,
      zoom: camera.zoom,
      marginX: this.cacheMarginX,
      marginY: this.cacheMarginY,
      cells: cellsBuffer,
      debugRegions: debugBuffer,
    };
    this.pendingWorkerRender = {
      id,
      camera: { ...camera },
      worldBounds: { ...renderedWorldBounds },
      onReady,
      onFailure: () => {
        this.render(camera, cells, debugRegions, true, renderedWorldBounds);
        onReady();
      },
    };
    try {
      this.renderWorker.postMessage(request, [cellsBuffer, debugBuffer]);
      return true;
    } catch {
      this.pendingWorkerRender = null;
      this.renderWorker.terminate();
      this.renderWorker = null;
      return false;
    }
  }

  renderMinimap(camera: Camera, cells: readonly RasterCell[]): void {
    const { width, height } = this.minimap;
    this.overviewContext.clearRect(0, 0, this.overviewCanvas.width, this.overviewCanvas.height);
    this.overviewContext.save();
    this.overviewContext.translate(-WORLD_BOUNDS.x * OVERVIEW_SCALE, -WORLD_BOUNDS.y * OVERVIEW_SCALE);
    this.overviewContext.scale(OVERVIEW_SCALE, OVERVIEW_SCALE);
    this.drawCells(cells, this.overviewContext);
    this.overviewContext.restore();

    this.minimapContext.clearRect(0, 0, width, height);
    this.minimapContext.fillStyle = "#fbfbfb";
    this.minimapContext.fillRect(0, 0, width, height);
    this.drawMinimapGrid(width, height);
    this.minimapContext.drawImage(
      this.overviewCanvas,
      0,
      0,
      this.overviewCanvas.width,
      this.overviewCanvas.height,
      width / 2 + WORLD_BOUNDS.x * MINIMAP_SCALE,
      height / 2 + WORLD_BOUNDS.y * MINIMAP_SCALE,
      WORLD_BOUNDS.width * MINIMAP_SCALE,
      WORLD_BOUNDS.height * MINIMAP_SCALE,
    );
    this.minimapContext.strokeStyle = "#6466c9";
    this.minimapContext.lineWidth = 1;
    this.minimapContext.strokeRect(
      width / 2 - camera.x * MINIMAP_SCALE,
      height / 2 - camera.y * MINIMAP_SCALE,
      (this.area.clientWidth * MINIMAP_SCALE) / camera.zoom,
      (this.area.clientHeight * MINIMAP_SCALE) / camera.zoom,
    );
  }

  viewportBounds(camera: Camera): Bounds {
    return {
      x: -camera.x / camera.zoom,
      y: -camera.y / camera.zoom,
      width: this.area.clientWidth / camera.zoom,
      height: this.area.clientHeight / camera.zoom,
    };
  }

  renderBounds(camera: Camera): Bounds {
    return {
      x: (-camera.x - this.cacheMarginX) / camera.zoom,
      y: (-camera.y - this.cacheMarginY) / camera.zoom,
      width: this.cacheWidth / camera.zoom,
      height: this.cacheHeight / camera.zoom,
    };
  }

  toDataUrl(): string { return this.canvas.toDataURL("image/png"); }

  private initializeRenderWorker(): void {
    if (typeof OffscreenCanvas === "undefined" || typeof Worker === "undefined") return;
    if (!("transferToImageBitmap" in OffscreenCanvas.prototype)) return;

    try {
      const worker = createRenderWorker();
      worker.addEventListener("message", (event: MessageEvent<WorkerRenderResult>) => {
        if (event.data.type !== "rendered") return;
        const pending = this.pendingWorkerRender;
        if (!pending || event.data.id !== pending.id) {
          event.data.bitmap.close();
          return;
        }

        this.committedTreeContext.save();
        this.committedTreeContext.setTransform(1, 0, 0, 1, 0, 0);
        this.committedTreeContext.clearRect(
          0,
          0,
          this.committedTreeCanvas.width,
          this.committedTreeCanvas.height,
        );
        this.committedTreeContext.drawImage(event.data.bitmap, 0, 0);
        this.committedTreeContext.restore();
        event.data.bitmap.close();
        this.committedCamera = pending.camera;
        this.committedWorldBounds = pending.worldBounds;
        this.pendingWorkerRender = null;
        pending.onReady();
      });
      worker.addEventListener("error", () => {
        const pending = this.pendingWorkerRender;
        worker.terminate();
        if (this.renderWorker === worker) this.renderWorker = null;
        this.pendingWorkerRender = null;
        if (pending) pending.onFailure();
      });
      this.renderWorker = worker;
    } catch {
      this.renderWorker = null;
    }
  }

  private drawCells(cells: readonly RasterCell[], context: CanvasRenderingContext2D): void {
    const groups = new Map<number, Map<number, RasterCell[]>>();
    for (const cell of cells) {
      let regionsByColor = groups.get(cell.renderGroup ?? 0);
      if (!regionsByColor) {
        regionsByColor = new Map();
        groups.set(cell.renderGroup ?? 0, regionsByColor);
      }
      const regions = regionsByColor.get(cell.color);
      if (regions) regions.push(cell);
      else regionsByColor.set(cell.color, [cell]);
    }

    // Filling each cell separately makes Canvas anti-alias every shared edge,
    // exposing the quadtree topology as hairline gaps. A compound path is the
    // union of all equal-color leaves, so only the outside boundary is sampled.
    groups.forEach((regionsByColor) => {
      regionsByColor.forEach((regions, color) => {
        context.beginPath();
        for (const region of regions) {
          context.rect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
        }
        context.fillStyle = rgbaToCss(color);
        context.fill();
      });
    });
  }

  private drawSelection(
    viewport: DOMRect,
    camera: Camera,
    selection: RasterSelection | null,
    marquee: Bounds | null,
    selectionOffset: Point,
  ): void {
    if (!selection && !marquee) return;
    const isMoving = selection !== null
      && (selectionOffset.x !== 0 || selectionOffset.y !== 0);
    const selectionPath = selection && (
      isMoving || selection.cells.length <= SELECTION_HIGHLIGHT_CELL_LIMIT
    ) ? this.pathForSelection(selection) : null;

    if (selection && selectionPath && isMoving) {
      this.prepareSelectionPreview(selection, selectionPath, camera, viewport);
      this.context.save();
      this.context.globalCompositeOperation = "destination-out";
      this.context.drawImage(
        this.selectionMaskCanvas,
        0,
        0,
        viewport.width,
        viewport.height,
      );
      this.context.restore();

      this.context.drawImage(
        this.selectionPreviewCanvas,
        selectionOffset.x * camera.zoom,
        selectionOffset.y * camera.zoom,
        viewport.width,
        viewport.height,
      );
    }

    this.context.save();
    this.context.translate(camera.x, camera.y);
    this.context.scale(camera.zoom, camera.zoom);

    if (selection) {
      this.context.save();
      this.context.translate(selectionOffset.x, selectionOffset.y);
      if (!isMoving && selectionPath) {
        this.context.fillStyle = "rgb(91 93 209 / 0.22)";
        this.context.fill(selectionPath);
      }
      this.context.strokeStyle = "rgb(75 77 196 / 0.9)";
      this.context.lineWidth = 1 / camera.zoom;
      this.context.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
      this.context.strokeRect(
        selection.bounds.x,
        selection.bounds.y,
        selection.bounds.width,
        selection.bounds.height,
      );
      this.context.restore();
    }

    if (marquee) {
      this.context.fillStyle = "rgb(91 93 209 / 0.08)";
      this.context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
      this.context.strokeStyle = "rgb(75 77 196 / 0.95)";
      this.context.lineWidth = 1 / camera.zoom;
      this.context.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
      this.context.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    }

    this.context.restore();
  }

  private pathForSelection(selection: RasterSelection): Path2D {
    if (selection === this.pathSelection && this.pathSelectionValue) {
      return this.pathSelectionValue;
    }
    const path = new Path2D();
    for (const cell of selection.cells) {
      path.rect(cell.bounds.x, cell.bounds.y, cell.bounds.width, cell.bounds.height);
    }
    this.pathSelection = selection;
    this.pathSelectionValue = path;
    return path;
  }

  private prepareSelectionPreview(
    selection: RasterSelection,
    path: Path2D,
    camera: Camera,
    viewport: DOMRect,
  ): void {
    if (
      selection === this.previewSelection
      && this.previewCamera?.x === camera.x
      && this.previewCamera.y === camera.y
      && this.previewCamera.zoom === camera.zoom
    ) return;

    this.selectionMaskContext.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    this.selectionMaskContext.clearRect(0, 0, viewport.width, viewport.height);
    this.selectionMaskContext.save();
    this.selectionMaskContext.translate(camera.x, camera.y);
    this.selectionMaskContext.scale(camera.zoom, camera.zoom);
    this.selectionMaskContext.fillStyle = "#000";
    this.selectionMaskContext.fill(path);
    this.selectionMaskContext.restore();

    this.selectionPreviewContext.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    this.selectionPreviewContext.clearRect(0, 0, viewport.width, viewport.height);
    this.selectionPreviewContext.drawImage(
      this.treeCanvas,
      0,
      0,
      viewport.width,
      viewport.height,
    );
    this.selectionPreviewContext.globalCompositeOperation = "destination-in";
    this.selectionPreviewContext.drawImage(
      this.selectionMaskCanvas,
      0,
      0,
      viewport.width,
      viewport.height,
    );
    this.selectionPreviewContext.globalCompositeOperation = "source-atop";
    this.selectionPreviewContext.fillStyle = "rgb(91 93 209 / 0.22)";
    this.selectionPreviewContext.fillRect(0, 0, viewport.width, viewport.height);
    this.selectionPreviewContext.globalCompositeOperation = "source-over";
    this.previewSelection = selection;
    this.previewCamera = { ...camera };
  }

  private drawDebugRegions(
    regions: readonly QuadDebugRegion[],
    context: CanvasRenderingContext2D,
    zoom: number,
  ): void {
    if (regions.length === 0) return;
    context.save();
    context.lineWidth = 1 / zoom;
    for (const region of regions) {
      const hue = 255 + (region.depth * 17) % 95;
      const alpha = region.occupied ? 0.62 : 0.24;
      context.strokeStyle = `hsl(${hue} 82% 48% / ${alpha})`;
      context.strokeRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
    }
    context.restore();
  }

  private drawTreeForCamera(viewport: DOMRect, camera: Camera): void {
    this.drawOverviewForCamera(camera);

    // The overview is only a fallback for world space outside the detailed
    // cache. Remove it beneath the cache before compositing; otherwise its
    // enlarged pixels show through the detailed stroke's antialiased edges.
    if (this.committedWorldBounds) {
      const coverageLeft = Math.max(0, this.committedWorldBounds.x * camera.zoom + camera.x);
      const coverageTop = Math.max(0, this.committedWorldBounds.y * camera.zoom + camera.y);
      const coverageRight = Math.min(
        viewport.width,
        (this.committedWorldBounds.x + this.committedWorldBounds.width) * camera.zoom + camera.x,
      );
      const coverageBottom = Math.min(
        viewport.height,
        (this.committedWorldBounds.y + this.committedWorldBounds.height) * camera.zoom + camera.y,
      );
      if (coverageRight > coverageLeft && coverageBottom > coverageTop) {
        this.treeContext.clearRect(
          coverageLeft,
          coverageTop,
          coverageRight - coverageLeft,
          coverageBottom - coverageTop,
        );
      }
    }

    const zoomRatio = camera.zoom / this.committedCamera.zoom;
    const targetX = camera.x - (this.committedCamera.x + this.cacheMarginX) * zoomRatio;
    const targetY = camera.y - (this.committedCamera.y + this.cacheMarginY) * zoomRatio;

    // Copy only the visible portion of the oversized cache. The previous
    // 5-argument drawImage call asked Canvas to resample the entire cache and
    // relied on clipping, which becomes costly on high-DPI, zoomed-out views.
    const sourceX = Math.max(0, -targetX / zoomRatio);
    const sourceY = Math.max(0, -targetY / zoomRatio);
    const sourceRight = Math.min(this.cacheWidth, (viewport.width - targetX) / zoomRatio);
    const sourceBottom = Math.min(this.cacheHeight, (viewport.height - targetY) / zoomRatio);
    const sourceWidth = sourceRight - sourceX;
    const sourceHeight = sourceBottom - sourceY;
    if (sourceWidth <= 0 || sourceHeight <= 0) return;

    const destinationX = targetX + sourceX * zoomRatio;
    const destinationY = targetY + sourceY * zoomRatio;
    this.treeContext.drawImage(
      this.committedTreeCanvas,
      sourceX * this.pixelScale,
      sourceY * this.pixelScale,
      sourceWidth * this.pixelScale,
      sourceHeight * this.pixelScale,
      destinationX,
      destinationY,
      sourceWidth * zoomRatio,
      sourceHeight * zoomRatio,
    );
  }

  private drawOverviewForCamera(camera: Camera): void {
    const viewport = this.viewportBounds(camera);
    const left = Math.max(viewport.x, WORLD_BOUNDS.x);
    const top = Math.max(viewport.y, WORLD_BOUNDS.y);
    const right = Math.min(viewport.x + viewport.width, WORLD_BOUNDS.x + WORLD_BOUNDS.width);
    const bottom = Math.min(viewport.y + viewport.height, WORLD_BOUNDS.y + WORLD_BOUNDS.height);
    if (right <= left || bottom <= top) return;

    this.treeContext.drawImage(
      this.overviewCanvas,
      (left - WORLD_BOUNDS.x) * OVERVIEW_SCALE,
      (top - WORLD_BOUNDS.y) * OVERVIEW_SCALE,
      (right - left) * OVERVIEW_SCALE,
      (bottom - top) * OVERVIEW_SCALE,
      left * camera.zoom + camera.x,
      top * camera.zoom + camera.y,
      (right - left) * camera.zoom,
      (bottom - top) * camera.zoom,
    );
  }

  private drawMinimapGrid(width: number, height: number): void {
    this.minimapContext.strokeStyle = "#eeeef0";
    for (let x = 16; x < width; x += 16) this.drawLine(this.minimapContext, x, 0, x, height);
    for (let y = 15; y < height; y += 15) this.drawLine(this.minimapContext, 0, y, width, y);
  }

  private drawLine(context: CanvasRenderingContext2D, fromX: number, fromY: number, toX: number, toY: number): void {
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }
}

function packCells(cells: readonly RasterCell[]): ArrayBuffer {
  const buffer = new ArrayBuffer(cells.length * PACKED_CELL_BYTES);
  const view = new DataView(buffer);
  cells.forEach((cell, index) => {
    const offset = index * PACKED_CELL_BYTES;
    view.setFloat32(offset, cell.bounds.x, true);
    view.setFloat32(offset + 4, cell.bounds.y, true);
    view.setFloat32(offset + 8, cell.bounds.width, true);
    view.setFloat32(offset + 12, cell.bounds.height, true);
    view.setUint32(offset + 16, cell.color, true);
    view.setUint32(offset + 20, cell.renderGroup ?? 0, true);
  });
  return buffer;
}

function packDebugRegions(regions: readonly QuadDebugRegion[]): ArrayBuffer {
  const packed = new Float32Array(regions.length * PACKED_DEBUG_REGION_FLOATS);
  regions.forEach((region, index) => {
    const offset = index * PACKED_DEBUG_REGION_FLOATS;
    packed[offset] = region.bounds.x;
    packed[offset + 1] = region.bounds.y;
    packed[offset + 2] = region.bounds.width;
    packed[offset + 3] = region.bounds.height;
    packed[offset + 4] = region.depth;
    packed[offset + 5] = region.occupied ? 1 : 0;
  });
  return packed.buffer;
}
