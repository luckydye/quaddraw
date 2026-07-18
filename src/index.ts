import { CanvasRenderer } from "./canvas-renderer";
import { DrawingStore } from "./drawing-store";
import type { Bounds, BrushAction, Camera, Point, QuadDebugRegion, RasterCell, Tool } from "./types";

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const ZOOM_BUTTON_FACTOR = 1.2;
const WHEEL_ZOOM_SENSITIVITY = 0.0012;
const MAX_WHEEL_DELTA = 120;
const ERASER_WIDTH = 28;

const elements = {
  area: requiredElement<HTMLElement>("#canvasArea"),
  canvas: requiredElement<HTMLCanvasElement>("#drawingCanvas"),
  minimap: requiredElement<HTMLCanvasElement>("#minimapCanvas"),
  hint: requiredElement<HTMLElement>("#canvasHint"),
  strokeCount: requiredElement<HTMLElement>("#strokeCount"),
  nodeCount: requiredElement<HTMLElement>("#nodeCount"),
  snapshotCompressedSize: requiredElement<HTMLElement>("#snapshotCompressedSize"),
  snapshotUncompressedSize: requiredElement<HTMLElement>("#snapshotUncompressedSize"),
  weight: requiredElement<HTMLInputElement>("#weight"),
  weightValue: requiredElement<HTMLOutputElement>("#weightValue"),
  density: requiredElement<HTMLInputElement>("#density"),
  densityValue: requiredElement<HTMLOutputElement>("#densityValue"),
  zoomLevel: requiredElement<HTMLButtonElement>("#zoomLevel"),
  debugTree: requiredElement<HTMLButtonElement>("#debugTree"),
  toast: requiredElement<HTMLElement>("#toast"),
};

const store = new DrawingStore();
const renderer = new CanvasRenderer(elements.canvas, elements.minimap, elements.area);

let camera: Camera = { x: 0, y: 0, zoom: 1 };
let activeTool: Tool = "pen";
let activeColor = "#393b42";
let currentAction: BrushAction | null = null;
let visibleCells: readonly RasterCell[] = [];
let visibleDebugRegions: readonly QuadDebugRegion[] = [];
let renderedWorldBounds: Bounds | null = null;
let debugQuadtree = false;
let isPanning = false;
let isSpacePressed = false;
let lastPointerPosition: Point | null = null;
let viewportSettleTimer: number | undefined;

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required UI element not found: ${selector}`);
  }
  return element;
}

function render(redrawTree = true, redrawMinimap = redrawTree, offThread = false): void {
  if (redrawTree) {
    const viewport = currentAction ? renderer.viewportBounds(camera) : renderer.renderBounds(camera);
    renderedWorldBounds = viewport;
    visibleCells = store.visibleIn(viewport, camera.zoom);
    visibleDebugRegions = debugQuadtree ? store.debugLeavesIn(viewport, camera.zoom) : [];
  }

  const workerAccepted = redrawTree
    && offThread
    && renderedWorldBounds !== null
    && renderer.renderTreeOffThread(
      camera,
      visibleCells,
      visibleDebugRegions,
      renderedWorldBounds,
      () => renderer.render(camera, visibleCells, visibleDebugRegions, false, renderedWorldBounds),
    );
  renderer.render(camera, visibleCells, visibleDebugRegions, redrawTree && !workerAccepted, renderedWorldBounds);
  if (redrawMinimap) {
    renderer.renderMinimap(camera, store.allCells(renderer.overviewScale));
  }
  updateStatus();
}

function updateStatus(): void {
  setText(elements.strokeCount, String(store.strokeCount));
  setText(elements.nodeCount, String(store.nodeCount));
  setText(elements.snapshotCompressedSize, formatByteSize(store.snapshotSizes.compressedBytes));
  setText(elements.snapshotUncompressedSize, formatByteSize(store.snapshotSizes.uncompressedBytes));
  setText(elements.zoomLevel, `${Math.round(camera.zoom * 100)}%`);
}

function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value;
}

function formatByteSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  const kilobytes = bytes / 1_024;
  if (kilobytes < 1_024) return `${kilobytes.toFixed(kilobytes < 10 ? 1 : 0)} KB`;
  const megabytes = kilobytes / 1_024;
  return `${megabytes.toFixed(megabytes < 10 ? 1 : 0)} MB`;
}

function selectTool(tool: Tool): void {
  activeTool = tool;
  elements.area.dataset.tool = tool;

  document.querySelectorAll<HTMLElement>(".tool[data-tool]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tool === tool);
  });
}

function toggleQuadtreeDebug(): void {
  debugQuadtree = !debugQuadtree;
  elements.debugTree.classList.toggle("active", debugQuadtree);
  elements.debugTree.setAttribute("aria-pressed", String(debugQuadtree));
  render(true, false);
  showToast(`Quadtree debug ${debugQuadtree ? "on" : "off"}`);
}

function updateCameraZoom(nextZoom: number, focusPoint?: Point): void {
  const previousZoom = camera.zoom;
  camera.zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, nextZoom));

  if (focusPoint) {
    const zoomRatio = camera.zoom / previousZoom;
    camera.x = focusPoint.x - (focusPoint.x - camera.x) * zoomRatio;
    camera.y = focusPoint.y - (focusPoint.y - camera.y) * zoomRatio;
  }

  renderViewportPreview();
}

function normalizedWheelDelta(event: WheelEvent): number {
  const modeScale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? elements.area.clientHeight
      : 1;
  const pixelDelta = event.deltaY * modeScale;
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, pixelDelta));
}

function renderViewportPreview(): void {
  // Transform the detailed cache immediately. A whole-world quadtree LOD sits
  // behind it, so newly exposed areas remain visible without rebuilding the
  // expensive full-resolution cache during the navigation gesture.
  render(false, false);
  window.clearTimeout(viewportSettleTimer);
  viewportSettleTimer = window.setTimeout(() => {
    render(true, true, true);
  }, 120);
}

function beginDrawing(point: Point): void {
  currentAction = store.createStroke(
    point,
    activeColor,
    Number(elements.weight.value),
    Number(elements.density.value) / 100,
  );
  elements.hint.style.opacity = "0";
  render(true, false);
}

function finishInteraction(): void {
  const finishedPanning = isPanning && currentAction === null;
  if (currentAction) {
    store.commit(currentAction);
    currentAction = null;
  }

  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-panning");
  window.clearTimeout(viewportSettleTimer);
  render(true, true, finishedPanning);
}

function showToast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.setTimeout(() => elements.toast.classList.remove("show"), 1_800);
}

function bindCanvasEvents(): void {
  elements.canvas.addEventListener("pointerdown", (event) => {
    elements.canvas.setPointerCapture(event.pointerId);
    const point = renderer.screenToWorld(event, camera);
    lastPointerPosition = { x: event.clientX, y: event.clientY };

    if (activeTool === "pen" && !isSpacePressed) {
      beginDrawing(point);
      return;
    }

    if (activeTool === "eraser" && !isSpacePressed) {
      currentAction = store.createEraser(point, ERASER_WIDTH);
      render(true, false);
      return;
    }

    if (activeTool === "hand" || isSpacePressed) {
      isPanning = true;
      elements.area.classList.add("is-panning");
    }
  });

  elements.canvas.addEventListener("pointermove", (event) => {
    if (currentAction) {
      const coalescedEvents = event.getCoalescedEvents?.() ?? [event];
      for (const coalescedEvent of coalescedEvents) {
        store.appendPoint(currentAction, renderer.screenToWorld(coalescedEvent, camera));
      }
      render(true, false);
      return;
    }

    if (isPanning && lastPointerPosition) {
      camera.x += event.clientX - lastPointerPosition.x;
      camera.y += event.clientY - lastPointerPosition.y;
      lastPointerPosition = { x: event.clientX, y: event.clientY };
      renderViewportPreview();
    }
  });

  elements.canvas.addEventListener("pointerup", finishInteraction);
  elements.canvas.addEventListener("pointercancel", finishInteraction);

  elements.area.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const canvasBounds = elements.canvas.getBoundingClientRect();
      const focusPoint = {
        x: event.clientX - canvasBounds.left,
        y: event.clientY - canvasBounds.top,
      };
      const zoomFactor = Math.exp(-normalizedWheelDelta(event) * WHEEL_ZOOM_SENSITIVITY);

      updateCameraZoom(camera.zoom * zoomFactor, focusPoint);
    },
    { passive: false },
  );
}

function bindControls(): void {
  document.querySelectorAll<HTMLButtonElement>(".tool[data-tool]").forEach((button) => {
    button.addEventListener("click", () => selectTool(button.dataset.tool as Tool));
  });

  elements.debugTree.addEventListener("click", toggleQuadtreeDebug);

  elements.weight.addEventListener("input", () => {
    elements.weightValue.textContent = `${elements.weight.value} px`;
  });

  elements.density.addEventListener("input", () => {
    elements.densityValue.textContent = `${elements.density.value}%`;
  });

  document.querySelectorAll<HTMLButtonElement>("#swatches button").forEach((button) => {
    button.addEventListener("click", () => {
      activeColor = button.dataset.color!;
      document.querySelectorAll("#swatches button").forEach((swatch) => swatch.classList.remove("selected"));
      button.classList.add("selected");
    });
  });

  requiredElement<HTMLButtonElement>("#zoomIn").addEventListener("click", () => {
    updateCameraZoom(camera.zoom * ZOOM_BUTTON_FACTOR);
  });

  requiredElement<HTMLButtonElement>("#zoomOut").addEventListener("click", () => {
    updateCameraZoom(camera.zoom / ZOOM_BUTTON_FACTOR);
  });

  requiredElement<HTMLButtonElement>("#undo").addEventListener("click", () => {
    if (store.undo()) {
      render();
    }
  });

  requiredElement<HTMLButtonElement>("#redo").addEventListener("click", () => {
    if (store.redo()) {
      render();
    }
  });

  requiredElement<HTMLButtonElement>("#clearButton").addEventListener("click", () => {
    store.clear();
    render();
    showToast("Canvas cleared");
  });

  requiredElement<HTMLButtonElement>("#exportButton").addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = "quaddraw-canvas.png";
    link.href = renderer.toDataUrl();
    link.click();
    showToast("Canvas exported as PNG");
  });

}

function bindKeyboardShortcuts(): void {
  window.addEventListener("keydown", (event) => {
    if (event.code === "Space") {
      isSpacePressed = true;
      elements.area.classList.add("is-panning");
    }

    if (event.key.toLowerCase() === "p") selectTool("pen");
    if (event.key.toLowerCase() === "e") selectTool("eraser");
    if (event.key.toLowerCase() === "h") selectTool("hand");
    if (event.key.toLowerCase() === "q" && !event.metaKey && !event.ctrlKey && !event.repeat) {
      toggleQuadtreeDebug();
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      if (event.shiftKey ? store.redo() : store.undo()) {
        render();
      }
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      isSpacePressed = false;
      if (!isPanning) {
        elements.area.classList.remove("is-panning");
      }
    }
  });
}

async function initialize(): Promise<void> {
  await store.restore();
  store.subscribeSnapshotSize(updateStatus);
  bindCanvasEvents();
  bindControls();
  bindKeyboardShortcuts();
  new ResizeObserver(() => {
    renderer.resize();
    render();
  }).observe(elements.area);
  renderer.resize();
  render();
}

void initialize();
