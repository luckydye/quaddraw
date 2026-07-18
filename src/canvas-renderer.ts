import { rgbaToCss } from "./quadtree";
import type { Bounds, Camera, Point, QuadDebugRegion, RasterCell } from "./types";

const GRID_SIZE = 40;
const MINIMAP_SCALE = 0.012;

/** Renders colored quadtree regions without reconstructing vector paths. */
export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly committedTreeCanvas = document.createElement("canvas");
  private readonly committedTreeContext: CanvasRenderingContext2D;
  private readonly treeCanvas = document.createElement("canvas");
  private readonly treeContext: CanvasRenderingContext2D;
  private readonly minimapContext: CanvasRenderingContext2D;
  private committedCamera: Camera = { x: 0, y: 0, zoom: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly minimap: HTMLCanvasElement,
    private readonly area: HTMLElement,
  ) {
    this.context = canvas.getContext("2d")!;
    this.committedTreeContext = this.committedTreeCanvas.getContext("2d")!;
    this.treeContext = this.treeCanvas.getContext("2d")!;
    this.minimapContext = minimap.getContext("2d")!;
  }

  resize(): void {
    const bounds = this.area.getBoundingClientRect();
    const scale = window.devicePixelRatio;
    this.canvas.width = bounds.width * scale;
    this.canvas.height = bounds.height * scale;
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.committedTreeCanvas.width = bounds.width * scale;
    this.committedTreeCanvas.height = bounds.height * scale;
    this.committedTreeContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.treeCanvas.width = bounds.width * scale;
    this.treeCanvas.height = bounds.height * scale;
    this.treeContext.setTransform(scale, 0, 0, scale, 0, 0);
  }

  screenToWorld(event: PointerEvent, camera: Camera): Point {
    const bounds = this.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left - camera.x) / camera.zoom,
      y: (event.clientY - bounds.top - camera.y) / camera.zoom,
      time: event.timeStamp,
    };
  }

  render(
    camera: Camera,
    cells: readonly RasterCell[],
    debugRegions: readonly QuadDebugRegion[],
    redrawTree: boolean,
  ): void {
    const viewport = this.area.getBoundingClientRect();
    if (redrawTree) {
      this.committedTreeContext.clearRect(0, 0, viewport.width, viewport.height);
      this.committedTreeContext.save();
      this.committedTreeContext.translate(camera.x, camera.y);
      this.committedTreeContext.scale(camera.zoom, camera.zoom);
      this.drawCells(cells, this.committedTreeContext);
      this.drawDebugRegions(debugRegions, this.committedTreeContext, camera.zoom);
      this.committedTreeContext.restore();
      this.committedCamera = { ...camera };
    }

    this.treeContext.clearRect(0, 0, viewport.width, viewport.height);
    this.drawTreeForCamera(viewport, camera);
    this.context.clearRect(0, 0, viewport.width, viewport.height);
    this.drawGrid(viewport, camera);
    this.context.drawImage(this.treeCanvas, 0, 0, viewport.width, viewport.height);
  }

  renderMinimap(camera: Camera, cells: readonly RasterCell[]): void {
    const { width, height } = this.minimap;
    this.minimapContext.clearRect(0, 0, width, height);
    this.minimapContext.fillStyle = "#fbfbfb";
    this.minimapContext.fillRect(0, 0, width, height);
    this.drawMinimapGrid(width, height);
    this.minimapContext.save();
    this.minimapContext.translate(width / 2, height / 2);
    this.minimapContext.scale(MINIMAP_SCALE, MINIMAP_SCALE);
    this.drawCells(cells, this.minimapContext);
    this.minimapContext.restore();
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

  toDataUrl(): string { return this.canvas.toDataURL("image/png"); }

  private drawCells(cells: readonly RasterCell[], context: CanvasRenderingContext2D): void {
    const regionsByColor = new Map<number, RasterCell[]>();
    for (const cell of cells) {
      const regions = regionsByColor.get(cell.color);
      if (regions) regions.push(cell);
      else regionsByColor.set(cell.color, [cell]);
    }

    // Filling each cell separately makes Canvas anti-alias every shared edge,
    // exposing the quadtree topology as hairline gaps. A compound path is the
    // union of all equal-color leaves, so only the outside boundary is sampled.
    regionsByColor.forEach((regions, color) => {
      context.beginPath();
      for (const region of regions) {
        context.rect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
      }
      context.fillStyle = rgbaToCss(color);
      context.fill();
    });
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

  private drawGrid(viewport: DOMRect, camera: Camera): void {
    const step = GRID_SIZE * camera.zoom;
    const firstX = ((camera.x % step) + step) % step;
    const firstY = ((camera.y % step) + step) % step;
    this.context.save();
    this.context.strokeStyle = "#ececec";
    this.context.lineWidth = 1;
    for (let x = firstX; x < viewport.width; x += step) this.drawLine(this.context, x + 0.5, 0, x + 0.5, viewport.height);
    for (let y = firstY; y < viewport.height; y += step) this.drawLine(this.context, 0, y + 0.5, viewport.width, y + 0.5);
    this.context.strokeStyle = "#dddde0";
    this.drawLine(this.context, 0, camera.y + 0.5, viewport.width, camera.y + 0.5);
    this.drawLine(this.context, camera.x + 0.5, 0, camera.x + 0.5, viewport.height);
    this.context.restore();
  }

  private drawTreeForCamera(viewport: DOMRect, camera: Camera): void {
    const zoomRatio = camera.zoom / this.committedCamera.zoom;
    const targetX = camera.x - this.committedCamera.x * zoomRatio;
    const targetY = camera.y - this.committedCamera.y * zoomRatio;
    this.treeContext.drawImage(
      this.committedTreeCanvas,
      targetX,
      targetY,
      viewport.width * zoomRatio,
      viewport.height * zoomRatio,
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
