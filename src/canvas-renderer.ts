import type { Camera, Bounds, Point, Stroke } from "./types";
import { freezeStrokeGeometry } from "./stroke-geometry";

const GRID_SIZE = 40;
const MINIMAP_SCALE = 0.012;

/** Renders the world-coordinate drawing surface and its minimap. */
export class CanvasRenderer {
  private readonly context: CanvasRenderingContext2D;
  private readonly committedInkCanvas = document.createElement("canvas");
  private readonly committedInkContext: CanvasRenderingContext2D;
  private readonly inkCanvas = document.createElement("canvas");
  private readonly inkContext: CanvasRenderingContext2D;
  private readonly minimapContext: CanvasRenderingContext2D;
  private committedCamera: Camera = { x: 0, y: 0, zoom: 1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly minimap: HTMLCanvasElement,
    private readonly area: HTMLElement,
  ) {
    this.context = canvas.getContext("2d")!;
    this.committedInkContext = this.committedInkCanvas.getContext("2d")!;
    this.inkContext = this.inkCanvas.getContext("2d")!;
    this.minimapContext = minimap.getContext("2d")!;
  }

  resize(): void {
    const bounds = this.area.getBoundingClientRect();
    const scale = window.devicePixelRatio;

    this.canvas.width = bounds.width * scale;
    this.canvas.height = bounds.height * scale;
    this.context.setTransform(scale, 0, 0, scale, 0, 0);
    this.committedInkCanvas.width = bounds.width * scale;
    this.committedInkCanvas.height = bounds.height * scale;
    this.committedInkContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.inkCanvas.width = bounds.width * scale;
    this.inkCanvas.height = bounds.height * scale;
    this.inkContext.setTransform(scale, 0, 0, scale, 0, 0);
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
    strokes: readonly Stroke[],
    currentStroke: Stroke | null,
    redrawCommittedInk: boolean,
  ): void {
    const viewport = this.area.getBoundingClientRect();

    if (redrawCommittedInk) {
      this.committedInkContext.clearRect(0, 0, viewport.width, viewport.height);
      this.committedInkContext.save();
      this.committedInkContext.translate(camera.x, camera.y);
      this.committedInkContext.scale(camera.zoom, camera.zoom);
      strokes.forEach((stroke) => this.drawStroke(stroke, this.committedInkContext));
      this.committedInkContext.restore();
      this.committedCamera = { ...camera };
    }

    this.inkContext.clearRect(0, 0, viewport.width, viewport.height);
    this.drawCommittedInkForCamera(viewport, camera);

    if (currentStroke) {
      this.inkContext.save();
      this.inkContext.translate(camera.x, camera.y);
      this.inkContext.scale(camera.zoom, camera.zoom);
      this.drawStroke(currentStroke, this.inkContext);
      this.inkContext.restore();
    }

    this.context.clearRect(0, 0, viewport.width, viewport.height);
    this.drawGrid(viewport, camera);
    this.context.drawImage(this.inkCanvas, 0, 0, viewport.width, viewport.height);
  }

  renderMinimap(camera: Camera, strokes: readonly Stroke[]): void {
    const { width, height } = this.minimap;
    this.minimapContext.clearRect(0, 0, width, height);
    this.minimapContext.fillStyle = "#fbfbfb";
    this.minimapContext.fillRect(0, 0, width, height);
    this.drawMinimapGrid(width, height);

    this.minimapContext.save();
    this.minimapContext.translate(width / 2, height / 2);
    this.minimapContext.scale(MINIMAP_SCALE, MINIMAP_SCALE);
    strokes.forEach((stroke) => this.drawStroke(stroke, this.minimapContext));
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

  toDataUrl(): string {
    return this.canvas.toDataURL("image/png");
  }

  private drawGrid(viewport: DOMRect, camera: Camera): void {
    const step = GRID_SIZE * camera.zoom;
    const firstX = ((camera.x % step) + step) % step;
    const firstY = ((camera.y % step) + step) % step;

    this.context.save();
    this.context.strokeStyle = "#ececec";
    this.context.lineWidth = 1;

    for (let x = firstX; x < viewport.width; x += step) {
      this.drawLine(this.context, x + 0.5, 0, x + 0.5, viewport.height);
    }

    for (let y = firstY; y < viewport.height; y += step) {
      this.drawLine(this.context, 0, y + 0.5, viewport.width, y + 0.5);
    }

    this.context.strokeStyle = "#dddde0";
    this.drawLine(this.context, 0, camera.y + 0.5, viewport.width, camera.y + 0.5);
    this.drawLine(this.context, camera.x + 0.5, 0, camera.x + 0.5, viewport.height);
    this.context.restore();
  }

  /** Scales the cached committed scene during pan/zoom until a precise redraw is due. */
  private drawCommittedInkForCamera(viewport: DOMRect, camera: Camera): void {
    const zoomRatio = camera.zoom / this.committedCamera.zoom;
    const targetX = camera.x - this.committedCamera.x * zoomRatio;
    const targetY = camera.y - this.committedCamera.y * zoomRatio;

    this.inkContext.drawImage(
      this.committedInkCanvas,
      targetX,
      targetY,
      viewport.width * zoomRatio,
      viewport.height * zoomRatio,
    );
  }

  private drawMinimapGrid(width: number, height: number): void {
    this.minimapContext.strokeStyle = "#eeeef0";

    for (let x = 16; x < width; x += 16) {
      this.drawLine(this.minimapContext, x, 0, x, height);
    }

    for (let y = 15; y < height; y += 15) {
      this.drawLine(this.minimapContext, 0, y, width, y);
    }
  }

  private drawStroke(stroke: Stroke, context: CanvasRenderingContext2D): void {
    if (stroke.points.length === 0) {
      return;
    }

    if (stroke.points.length === 1) {
      this.drawDot(stroke.points[0], stroke, context);
      return;
    }

    if (!stroke.segments) {
      freezeStrokeGeometry(stroke);
    }

    context.save();
    context.globalCompositeOperation = stroke.kind === "eraser" ? "destination-out" : "source-over";
    context.strokeStyle = stroke.color;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.shadowColor = stroke.softness ? stroke.color : "transparent";

    for (const segment of stroke.segments ?? []) {
      context.lineWidth = segment.width;
      context.shadowBlur = stroke.softness ? Math.max(1.25, context.lineWidth * stroke.softness) : 0;
      context.beginPath();
      context.moveTo(segment.start.x, segment.start.y);
      context.bezierCurveTo(
        segment.controlOne.x,
        segment.controlOne.y,
        segment.controlTwo.x,
        segment.controlTwo.y,
        segment.end.x,
        segment.end.y,
      );
      context.stroke();
    }
    context.restore();
  }

  private drawLine(
    context: CanvasRenderingContext2D,
    fromX: number,
    fromY: number,
    toX: number,
    toY: number,
  ): void {
    context.beginPath();
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    context.stroke();
  }

  private drawDot(point: Point, stroke: Stroke, context: CanvasRenderingContext2D): void {
    context.save();
    context.globalCompositeOperation = stroke.kind === "eraser" ? "destination-out" : "source-over";
    context.fillStyle = stroke.color;
    context.shadowColor = stroke.softness ? stroke.color : "transparent";
    context.shadowBlur = stroke.softness ? Math.max(1.25, stroke.width * stroke.softness) : 0;
    context.beginPath();
    context.arc(point.x, point.y, stroke.width / 2, 0, Math.PI * 2);
    context.fill();
    context.restore();
  }
}
