import { rgbaToCss } from "./quadtree";
import { WORLD_BOUNDS } from "./types";
import type {
  Bounds,
  Camera,
  Point,
  QuadDebugRegion,
  RasterCell,
  RasterSelection,
  RenderCellVisitor,
} from "./types";

const OVERVIEW_SCALE = 0.08;
// Cells are gathered for the viewport plus this fraction on every side, so a
// pan can travel that far before a fresh set is needed. A wider border trades a
// larger (but rarer) rebuild for more buffer-only pan frames.
const CACHE_MARGIN_FACTOR = 0.5;
// Refresh the prefetched cells once the viewport comes within this fraction of
// the built border's edge, leaving room to rebuild before coverage is lost.
const COVERAGE_REFRESH_SLACK = 0.2;
const SELECTION_HIGHLIGHT_CELL_LIMIT = 20_000;
const DEBUG_FLASH_DURATION_MS = 420;

// Per-instance vertex layout: four f32 world-space rect components followed by
// one packed u32 RGBA color. Twenty bytes stays a multiple of four so the whole
// instance buffer can be uploaded with a single writeBuffer call.
const INSTANCE_FLOATS = 5;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const UNIFORM_BYTES = 48;

// Reproduces the translucent marquee tint of the previous Canvas2D renderer.
const SELECTION_TINT: readonly [number, number, number, number] = [
  91 / 255,
  93 / 255,
  209 / 255,
  0.35,
];

const SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  camera: vec2f,
  zoom: f32,
  pixelScale: f32,
  // 1.0 forces full-coverage erasing so the cut pass clears the source
  // footprint even under semi-transparent textured ink.
  forceOpaque: f32,
  _pad: f32,
  tint: vec4f,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) position: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32,
      @location(0) rect: vec4f,
      @location(1) packed: u32) -> VSOut {
  // Snap every dyadic edge to a whole device pixel so shared quadtree
  // boundaries land on one coordinate and never leave hairline seams.
  let left = round((rect.x * u.zoom + u.camera.x) * u.pixelScale);
  let top = round((rect.y * u.zoom + u.camera.y) * u.pixelScale);
  let right = round(((rect.x + rect.z) * u.zoom + u.camera.x) * u.pixelScale);
  let bottom = round(((rect.y + rect.w) * u.zoom + u.camera.y) * u.pixelScale);

  var px = left;
  var py = top;
  if (vertexIndex == 1u || vertexIndex == 3u) { px = right; }
  if (vertexIndex == 2u || vertexIndex == 3u) { py = bottom; }

  var out: VSOut;
  out.position = vec4f(
    px / u.resolution.x * 2.0 - 1.0,
    1.0 - py / u.resolution.y * 2.0,
    0.0,
    1.0,
  );

  let r = f32((packed >> 24u) & 0xffu) / 255.0;
  let g = f32((packed >> 16u) & 0xffu) / 255.0;
  let b = f32((packed >> 8u) & 0xffu) / 255.0;
  let a = f32(packed & 0xffu) / 255.0;
  let rgb = mix(vec3f(r, g, b), u.tint.rgb, u.tint.a);
  out.color = vec4f(rgb, a);
  return out;
}

@fragment
fn fs(in: VSOut) -> @location(0) vec4f {
  // Premultiplied output pairs with the premultiplied canvas alpha mode.
  let a = select(in.color.a, 1.0, u.forceOpaque > 0.5);
  return vec4f(in.color.rgb * a, a);
}
`;

type InstanceBuffer = {
  buffer: GPUBuffer;
  capacity: number;
  count: number;
};

/** Draws colored quadtree cells as instanced GPU quads without a vector path. */
export class WebGPURenderer {
  readonly overviewScale = OVERVIEW_SCALE;
  private context: GPUCanvasContext | null = null;
  private readonly overlayCanvas = document.createElement("canvas");
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly debugFlashContext: CanvasRenderingContext2D;
  private readonly overviewCanvas = document.createElement("canvas");
  private readonly overviewContext: CanvasRenderingContext2D;
  private readonly minimapContext: CanvasRenderingContext2D;

  private device: GPUDevice | null = null;
  private format: GPUTextureFormat = "bgra8unorm";
  private overPipeline: GPURenderPipeline | null = null;
  private cutPipeline: GPURenderPipeline | null = null;
  private baseUniform: GPUBuffer | null = null;
  private cutUniform: GPUBuffer | null = null;
  private movedUniform: GPUBuffer | null = null;
  private baseBindGroup: GPUBindGroup | null = null;
  private cutBindGroup: GPUBindGroup | null = null;
  private movedBindGroup: GPUBindGroup | null = null;
  private cells: InstanceBuffer | null = null;
  private selection: InstanceBuffer | null = null;
  private selectionSource: RasterSelection | null = null;
  private readyPromise: Promise<void> | null = null;

  // Reused CPU staging for the cell instance stream. Cells are written here by
  // `cellSink` during collection, then uploaded once, so no per-frame array or
  // per-cell object is allocated.
  private staging = new ArrayBuffer(1024 * INSTANCE_BYTES);
  private stagingFloats = new Float32Array(this.staging);
  private stagingWords = new Uint32Array(this.staging);
  private stagingCount = 0;

  private pixelScale = 1;
  private canvasLeft = 0;
  private canvasTop = 0;
  private builtWorldBounds: Bounds | null = null;
  private builtCoversAllInk = false;
  private debugRegions: readonly QuadDebugRegion[] = [];
  private pathSelection: RasterSelection | null = null;
  private pathSelectionValue: Path2D | null = null;
  private debugFlashAnimation: Animation | null = null;
  private debugFlashCamera: Camera | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly debugFlashCanvas: HTMLCanvasElement,
    private readonly minimap: HTMLCanvasElement,
    private readonly area: HTMLElement,
  ) {
    // WebGPU acquisition is deferred to init() so a missing device surfaces as a
    // rejected promise the caller can report, never an uncaught constructor throw.
    // Selection, marquee, and lasso overlays remain vector 2D work on a canvas
    // stacked directly above the WebGPU output.
    this.overlayCanvas.className = "overlay-canvas";
    this.overlayCanvas.setAttribute("aria-hidden", "true");
    canvas.insertAdjacentElement("afterend", this.overlayCanvas);
    this.overlayContext = this.overlayCanvas.getContext("2d")!;
    this.debugFlashContext = debugFlashCanvas.getContext("2d")!;
    this.overviewContext = this.overviewCanvas.getContext("2d")!;
    this.minimapContext = minimap.getContext("2d")!;
    this.overviewCanvas.width = Math.ceil(WORLD_BOUNDS.width * OVERVIEW_SCALE);
    this.overviewCanvas.height = Math.ceil(WORLD_BOUNDS.height * OVERVIEW_SCALE);
  }

  /** Acquires the GPU device and builds the pipelines. Idempotent. */
  init(): Promise<void> {
    return this.readyPromise ??= this.initialize();
  }

  private async initialize(): Promise<void> {
    // `navigator.gpu` and the "webgpu" canvas context are both gated behind a
    // secure context, so a plain-HTTP LAN origin hides WebGPU even in a browser
    // that fully supports it. Diagnose that case explicitly.
    if (typeof navigator === "undefined" || !navigator.gpu) {
      throw new Error(
        typeof window !== "undefined" && !window.isSecureContext
          ? `WebGPU needs a secure context. This page was loaded over ${location.origin}; `
            + "open it via http://localhost or serve it over https."
          : "WebGPU is unavailable in this browser (navigator.gpu is missing).",
      );
    }
    const context = this.canvas.getContext("webgpu");
    if (!context) {
      throw new Error(
        "Could not create a WebGPU canvas context. If the page is not on "
        + "localhost or https, WebGPU is disabled; otherwise check chrome://gpu.",
      );
    }
    this.context = context;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error(
        "No WebGPU adapter is available. Hardware acceleration may be turned "
        + "off in settings, or the GPU is blocklisted (see chrome://gpu).",
      );
    }
    const device = await adapter.requestDevice();
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device, format: this.format, alphaMode: "premultiplied" });

    const module = device.createShaderModule({ code: SHADER });
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    const vertexLayout: GPUVertexBufferLayout = {
      arrayStride: INSTANCE_BYTES,
      stepMode: "instance",
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x4" },
        { shaderLocation: 1, offset: 16, format: "uint32" },
      ],
    };
    const target = (blend: GPUBlendState): GPUColorTargetState => ({ format: this.format, blend });
    const descriptor = (blend: GPUBlendState): GPURenderPipelineDescriptor => ({
      layout: pipelineLayout,
      vertex: { module, entryPoint: "vs", buffers: [vertexLayout] },
      fragment: { module, entryPoint: "fs", targets: [target(blend)] },
      primitive: { topology: "triangle-strip" },
    });
    this.overPipeline = device.createRenderPipeline(descriptor(OVER_BLEND));
    this.cutPipeline = device.createRenderPipeline(descriptor(CUT_BLEND));

    const uniform = (): GPUBuffer => device.createBuffer({
      size: UNIFORM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const bindGroup = (buffer: GPUBuffer): GPUBindGroup => device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer } }],
    });
    this.baseUniform = uniform();
    this.cutUniform = uniform();
    this.movedUniform = uniform();
    this.baseBindGroup = bindGroup(this.baseUniform);
    this.cutBindGroup = bindGroup(this.cutUniform);
    this.movedBindGroup = bindGroup(this.movedUniform);
    this.device = device;
  }

  resize(): void {
    const bounds = this.area.getBoundingClientRect();
    const scale = window.devicePixelRatio || 1;
    this.canvasLeft = bounds.left;
    this.canvasTop = bounds.top;
    this.pixelScale = scale;
    this.canvas.width = Math.max(1, Math.round(bounds.width * scale));
    this.canvas.height = Math.max(1, Math.round(bounds.height * scale));
    this.overlayCanvas.width = this.canvas.width;
    this.overlayCanvas.height = this.canvas.height;
    this.overlayContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.debugFlashCanvas.width = this.canvas.width;
    this.debugFlashCanvas.height = this.canvas.height;
    this.debugFlashContext.setTransform(scale, 0, 0, scale, 0, 0);
    this.clearDebugFlash();
    this.builtWorldBounds = null;
  }

  screenToWorld(event: PointerEvent, camera: Camera): Point {
    return {
      x: (event.clientX - this.canvasLeft - camera.x) / camera.zoom,
      y: (event.clientY - this.canvasTop - camera.y) / camera.zoom,
      time: event.timeStamp,
      pressure: event.pointerType === "pen" ? event.pressure : undefined,
    };
  }

  /**
   * Streams a fresh visible-cell set through `fill` straight into the GPU
   * instance buffer, then draws the frame. `fill` receives a sink to invoke
   * once per cell; no cell array is materialized.
   */
  render(
    camera: Camera,
    fill: (sink: RenderCellVisitor) => void,
    debugRegions: readonly QuadDebugRegion[],
    renderedWorldBounds: Bounds | null,
    coversAllInk: boolean,
    selection: RasterSelection | null = null,
    marquee: Bounds | null = null,
    lasso: readonly Point[] | null = null,
    selectionOffset: Point = { x: 0, y: 0 },
  ): void {
    if (!this.device) return;
    this.uploadCells(fill);
    this.builtWorldBounds = renderedWorldBounds;
    this.builtCoversAllInk = coversAllInk;
    this.debugRegions = debugRegions;
    if (debugRegions.length > 0) this.flashDebugRegions(camera, debugRegions);
    else this.clearDebugFlash();
    this.drawFrame(camera, selection, marquee, lasso, selectionOffset);
  }

  /** Redraws the last uploaded cells under a new camera or overlay state. */
  redraw(
    camera: Camera,
    selection: RasterSelection | null = null,
    marquee: Bounds | null = null,
    lasso: readonly Point[] | null = null,
    selectionOffset: Point = { x: 0, y: 0 },
  ): void {
    if (!this.device) return;
    this.drawFrame(camera, selection, marquee, lasso, selectionOffset);
  }

  /**
   * Whether the uploaded cells can be redrawn for the supplied viewport without
   * re-collecting the tree. Always true once the buffer holds every ink cell —
   * panning at the same zoom then reveals nothing new, so no rebuild is needed.
   */
  hasCoverageFor(bounds: Bounds): boolean {
    if (this.builtCoversAllInk) return true;
    const built = this.builtWorldBounds;
    return built !== null
      && bounds.x >= built.x
      && bounds.y >= built.y
      && bounds.x + bounds.width <= built.x + built.width
      && bounds.y + bounds.height <= built.y + built.height;
  }

  /**
   * True once a pan has consumed most of the prefetched border, signalling that
   * a fresh, recentered cell set should be gathered before coverage is actually
   * lost. Lets the caller rebuild off the input path instead of stalling a
   * pointermove once the viewport reaches the edge. When the buffer already
   * holds every ink cell there is nothing new to gather, so it stays false.
   */
  needsCoverageRefresh(bounds: Bounds): boolean {
    if (this.builtCoversAllInk) return false;
    const built = this.builtWorldBounds;
    if (!built) return true;
    const slackX = bounds.width * COVERAGE_REFRESH_SLACK;
    const slackY = bounds.height * COVERAGE_REFRESH_SLACK;
    return bounds.x - built.x < slackX
      || bounds.y - built.y < slackY
      || (built.x + built.width) - (bounds.x + bounds.width) < slackX
      || (built.y + built.height) - (bounds.y + bounds.height) < slackY;
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
    const viewport = this.viewportBounds(camera);
    const marginX = viewport.width * CACHE_MARGIN_FACTOR;
    const marginY = viewport.height * CACHE_MARGIN_FACTOR;
    return {
      x: viewport.x - marginX,
      y: viewport.y - marginY,
      width: viewport.width + marginX * 2,
      height: viewport.height + marginY * 2,
    };
  }

  renderMinimap(camera: Camera, cells: readonly RasterCell[]): void {
    this.overviewContext.clearRect(0, 0, this.overviewCanvas.width, this.overviewCanvas.height);
    this.overviewContext.save();
    this.overviewContext.translate(-WORLD_BOUNDS.x * OVERVIEW_SCALE, -WORLD_BOUNDS.y * OVERVIEW_SCALE);
    this.overviewContext.scale(OVERVIEW_SCALE, OVERVIEW_SCALE);
    this.drawCells2D(cells, this.overviewContext);
    this.overviewContext.restore();
    this.drawMinimap(camera);
  }

  /** Updates the persistent world overview after a localized drawing edit. */
  renderOverviewRegion(
    _camera: Camera,
    cells: readonly RasterCell[],
    worldBounds: Bounds,
  ): void {
    this.overviewContext.save();
    this.overviewContext.translate(-WORLD_BOUNDS.x * OVERVIEW_SCALE, -WORLD_BOUNDS.y * OVERVIEW_SCALE);
    this.overviewContext.scale(OVERVIEW_SCALE, OVERVIEW_SCALE);
    this.overviewContext.clearRect(worldBounds.x, worldBounds.y, worldBounds.width, worldBounds.height);
    this.overviewContext.beginPath();
    this.overviewContext.rect(worldBounds.x, worldBounds.y, worldBounds.width, worldBounds.height);
    this.overviewContext.clip();
    this.drawCells2D(cells, this.overviewContext);
    this.overviewContext.restore();
    this.drawMinimap(_camera);
  }

  toDataUrl(): string {
    // Re-present the current frame in this task so the canvas image source is
    // populated when the browser reads it back.
    return this.canvas.toDataURL("image/png");
  }

  private drawFrame(
    camera: Camera,
    selection: RasterSelection | null,
    marquee: Bounds | null,
    lasso: readonly Point[] | null,
    selectionOffset: Point,
  ): void {
    const device = this.device;
    if (!device || this.canvas.width === 0 || this.canvas.height === 0) return;
    const isMoving = selection !== null
      && (selectionOffset.x !== 0 || selectionOffset.y !== 0);
    if (isMoving && selection) this.ensureSelectionBuffer(selection);

    this.writeUniform(this.baseUniform!, camera, 0, 0, TRANSPARENT_TINT, false);
    if (isMoving) {
      this.writeUniform(this.cutUniform!, camera, 0, 0, TRANSPARENT_TINT, true);
      this.writeUniform(
        this.movedUniform!,
        camera,
        selectionOffset.x,
        selectionOffset.y,
        SELECTION_TINT,
        false,
      );
    }

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context!.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });

    if (this.cells && this.cells.count > 0) {
      pass.setPipeline(this.overPipeline!);
      pass.setBindGroup(0, this.baseBindGroup!);
      pass.setVertexBuffer(0, this.cells.buffer);
      pass.draw(4, this.cells.count);
    }

    if (isMoving && this.selection && this.selection.count > 0) {
      // Erase the ink at the source footprint, then paint the selected cells at
      // the dragged position. This mirrors the old destination-out compositing.
      pass.setPipeline(this.cutPipeline!);
      pass.setBindGroup(0, this.cutBindGroup!);
      pass.setVertexBuffer(0, this.selection.buffer);
      pass.draw(4, this.selection.count);

      pass.setPipeline(this.overPipeline!);
      pass.setBindGroup(0, this.movedBindGroup!);
      pass.setVertexBuffer(0, this.selection.buffer);
      pass.draw(4, this.selection.count);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);

    this.drawOverlay(camera, selection, marquee, lasso, selectionOffset, isMoving);
  }

  private drawOverlay(
    camera: Camera,
    selection: RasterSelection | null,
    marquee: Bounds | null,
    lasso: readonly Point[] | null,
    selectionOffset: Point,
    isMoving: boolean,
  ): void {
    const width = this.area.clientWidth;
    const height = this.area.clientHeight;
    const context = this.overlayContext;
    context.clearRect(0, 0, width, height);
    if (
      this.debugRegions.length === 0
      && !selection
      && !marquee
      && !lasso?.length
    ) return;

    context.save();
    context.translate(camera.x, camera.y);
    context.scale(camera.zoom, camera.zoom);

    this.drawDebugRegions(this.debugRegions, context, camera.zoom);

    if (selection) {
      context.save();
      context.translate(selectionOffset.x, selectionOffset.y);
      if (
        !isMoving
        && selection.cells.length <= SELECTION_HIGHLIGHT_CELL_LIMIT
      ) {
        context.fillStyle = "rgb(91 93 209 / 0.22)";
        context.fill(this.pathForSelection(selection));
      }
      context.strokeStyle = "rgb(75 77 196 / 0.9)";
      context.lineWidth = 1 / camera.zoom;
      context.setLineDash([5 / camera.zoom, 4 / camera.zoom]);
      context.strokeRect(
        selection.bounds.x,
        selection.bounds.y,
        selection.bounds.width,
        selection.bounds.height,
      );
      context.restore();
    }

    if (marquee) {
      context.fillStyle = "rgb(91 93 209 / 0.08)";
      context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
      context.strokeStyle = "rgb(75 77 196 / 0.95)";
      context.lineWidth = 1 / camera.zoom;
      context.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
      context.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
    }

    if (lasso?.length) {
      context.beginPath();
      context.moveTo(lasso[0].x, lasso[0].y);
      for (let index = 1; index < lasso.length; index++) {
        context.lineTo(lasso[index].x, lasso[index].y);
      }
      if (lasso.length >= 3) {
        context.closePath();
        context.fillStyle = "rgb(91 93 209 / 0.08)";
        context.fill();
      }
      context.strokeStyle = "rgb(75 77 196 / 0.95)";
      context.lineWidth = 1 / camera.zoom;
      context.setLineDash([6 / camera.zoom, 4 / camera.zoom]);
      context.stroke();
    }

    context.restore();
  }

  private readonly cellSink: RenderCellVisitor = (x, y, width, height, color) => {
    const index = this.stagingCount;
    if ((index + 1) * INSTANCE_FLOATS > this.stagingFloats.length) this.growStaging();
    const base = index * INSTANCE_FLOATS;
    this.stagingFloats[base] = x;
    this.stagingFloats[base + 1] = y;
    this.stagingFloats[base + 2] = width;
    this.stagingFloats[base + 3] = height;
    this.stagingWords[base + 4] = color >>> 0;
    this.stagingCount = index + 1;
  };

  private growStaging(): void {
    const next = new ArrayBuffer(this.staging.byteLength * 2);
    new Uint8Array(next).set(new Uint8Array(this.staging));
    this.staging = next;
    this.stagingFloats = new Float32Array(next);
    this.stagingWords = new Uint32Array(next);
  }

  private uploadCells(fill: (sink: RenderCellVisitor) => void): void {
    this.stagingCount = 0;
    fill(this.cellSink);
    const count = this.stagingCount;
    const target = this.ensureInstanceCapacity(this.cells, count);
    if (count > 0) {
      this.device!.queue.writeBuffer(target.buffer, 0, this.staging, 0, count * INSTANCE_BYTES);
    }
    target.count = count;
    this.cells = target;
  }

  private ensureInstanceCapacity(
    target: InstanceBuffer | null,
    count: number,
  ): InstanceBuffer {
    if (target && target.capacity >= count) return target;
    target?.buffer.destroy();
    const capacity = Math.max(count, target ? target.capacity * 2 : 1024);
    return {
      buffer: this.device!.createBuffer({
        size: Math.max(1, capacity) * INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      }),
      capacity,
      count: 0,
    };
  }

  private ensureSelectionBuffer(selection: RasterSelection): void {
    if (this.selectionSource === selection && this.selection) return;
    this.selection = this.uploadInstances(this.selection, selection.cells);
    this.selectionSource = selection;
  }

  private uploadInstances(
    target: InstanceBuffer | null,
    cells: readonly RasterCell[],
  ): InstanceBuffer {
    const device = this.device!;
    const staging = new ArrayBuffer(cells.length * INSTANCE_BYTES);
    const floats = new Float32Array(staging);
    const words = new Uint32Array(staging);
    for (let index = 0; index < cells.length; index++) {
      const base = index * INSTANCE_FLOATS;
      const { bounds, color } = cells[index];
      floats[base] = bounds.x;
      floats[base + 1] = bounds.y;
      floats[base + 2] = bounds.width;
      floats[base + 3] = bounds.height;
      words[base + 4] = color >>> 0;
    }

    if (!target || target.capacity < cells.length) {
      target?.buffer.destroy();
      const capacity = Math.max(cells.length, target ? target.capacity * 2 : 1024);
      target = {
        buffer: device.createBuffer({
          size: Math.max(1, capacity) * INSTANCE_BYTES,
          usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        }),
        capacity,
        count: 0,
      };
    }
    if (staging.byteLength > 0) device.queue.writeBuffer(target.buffer, 0, staging);
    target.count = cells.length;
    return target;
  }

  private writeUniform(
    buffer: GPUBuffer,
    camera: Camera,
    offsetX: number,
    offsetY: number,
    tint: readonly [number, number, number, number],
    forceOpaque: boolean,
  ): void {
    const data = new Float32Array(UNIFORM_BYTES / 4);
    data[0] = this.canvas.width;
    data[1] = this.canvas.height;
    data[2] = camera.x + offsetX * camera.zoom;
    data[3] = camera.y + offsetY * camera.zoom;
    data[4] = camera.zoom;
    data[5] = this.pixelScale;
    data[6] = forceOpaque ? 1 : 0;
    data[8] = tint[0];
    data[9] = tint[1];
    data[10] = tint[2];
    data[11] = tint[3];
    this.device!.queue.writeBuffer(buffer, 0, data);
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

  private drawCells2D(cells: readonly RasterCell[], context: CanvasRenderingContext2D): void {
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

    const transform = context.getTransform();
    context.save();
    context.setTransform(1, 0, 0, 1, 0, 0);
    groups.forEach((regionsByColor) => {
      regionsByColor.forEach((regions, color) => {
        context.beginPath();
        for (const region of regions) {
          const left = Math.round(region.bounds.x * transform.a + transform.e);
          const top = Math.round(region.bounds.y * transform.d + transform.f);
          const right = Math.round((region.bounds.x + region.bounds.width) * transform.a + transform.e);
          const bottom = Math.round((region.bounds.y + region.bounds.height) * transform.d + transform.f);
          if (right > left && bottom > top) context.rect(left, top, right - left, bottom - top);
        }
        context.fillStyle = rgbaToCss(color);
        context.fill();
      });
    });
    context.restore();
  }

  private drawDebugRegions(
    regions: readonly QuadDebugRegion[],
    context: CanvasRenderingContext2D,
    zoom: number,
  ): void {
    if (regions.length === 0) return;
    context.save();
    context.setLineDash([]);
    context.lineWidth = 1 / zoom;
    for (const region of regions) {
      const hue = 255 + (region.depth * 17) % 95;
      const alpha = region.occupied ? 0.62 : 0.24;
      context.strokeStyle = `hsl(${hue} 82% 48% / ${alpha})`;
      context.strokeRect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
    }
    context.restore();
  }

  private drawMinimap(camera: Camera): void {
    const { width, height } = this.minimap;
    const scale = Math.min(width / WORLD_BOUNDS.width, height / WORLD_BOUNDS.height);
    const worldLeft = (width - WORLD_BOUNDS.width * scale) / 2;
    const worldTop = (height - WORLD_BOUNDS.height * scale) / 2;
    const viewport = this.viewportBounds(camera);

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
      worldLeft,
      worldTop,
      WORLD_BOUNDS.width * scale,
      WORLD_BOUNDS.height * scale,
    );
    this.minimapContext.strokeStyle = "#6466c9";
    this.minimapContext.lineWidth = 1;
    this.minimapContext.strokeRect(
      worldLeft + (viewport.x - WORLD_BOUNDS.x) * scale,
      worldTop + (viewport.y - WORLD_BOUNDS.y) * scale,
      viewport.width * scale,
      viewport.height * scale,
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

  private flashDebugRegions(camera: Camera, regions: readonly QuadDebugRegion[]): void {
    if (!sameCamera(camera, this.debugFlashCamera)) {
      this.debugFlashContext.clearRect(0, 0, this.area.clientWidth, this.area.clientHeight);
    }
    this.debugFlashCamera = { ...camera };
    this.debugFlashContext.save();
    this.debugFlashContext.translate(camera.x, camera.y);
    this.debugFlashContext.scale(camera.zoom, camera.zoom);
    this.debugFlashContext.beginPath();
    for (const region of regions) {
      this.debugFlashContext.rect(region.bounds.x, region.bounds.y, region.bounds.width, region.bounds.height);
    }
    this.debugFlashContext.fillStyle = "rgb(255 214 51 / 0.3)";
    this.debugFlashContext.strokeStyle = "rgb(255 255 255 / 0.92)";
    this.debugFlashContext.lineWidth = 1.5 / camera.zoom;
    this.debugFlashContext.fill();
    this.debugFlashContext.stroke();
    this.debugFlashContext.restore();

    this.debugFlashAnimation?.cancel();
    const animation = this.debugFlashCanvas.animate(
      [{ opacity: 0.9 }, { opacity: 0 }],
      { duration: DEBUG_FLASH_DURATION_MS, easing: "cubic-bezier(.2, .8, .2, 1)" },
    );
    this.debugFlashAnimation = animation;
    animation.addEventListener("finish", () => {
      if (this.debugFlashAnimation !== animation) return;
      this.debugFlashAnimation = null;
      this.debugFlashCamera = null;
      this.debugFlashContext.clearRect(0, 0, this.area.clientWidth, this.area.clientHeight);
    }, { once: true });
  }

  private clearDebugFlash(): void {
    this.debugFlashAnimation?.cancel();
    this.debugFlashAnimation = null;
    this.debugFlashCamera = null;
    this.debugFlashContext.clearRect(0, 0, this.area.clientWidth, this.area.clientHeight);
  }
}

const OVER_BLEND: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
};

const CUT_BLEND: GPUBlendState = {
  color: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
  alpha: { srcFactor: "zero", dstFactor: "one-minus-src-alpha", operation: "add" },
};

const TRANSPARENT_TINT: readonly [number, number, number, number] = [0, 0, 0, 0];

function sameCamera(left: Camera, right: Camera | null): boolean {
  return right !== null
    && left.x === right.x
    && left.y === right.y
    && left.zoom === right.zoom;
}
