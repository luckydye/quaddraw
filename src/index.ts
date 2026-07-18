import { CanvasRenderer } from "./canvas-renderer";
import { DrawingStore } from "./drawing-store";
import type { BrushAction, Camera, Point, QuadDebugRegion, RasterCell, Tool } from "./types";

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 4;
const ZOOM_BUTTON_FACTOR = 1.2;
const WHEEL_ZOOM_IN_FACTOR = 1.12;
const WHEEL_ZOOM_OUT_FACTOR = 0.89;
const ERASER_WIDTH = 28;

const elements = {
  area: requiredElement<HTMLElement>("#canvasArea"),
  canvas: requiredElement<HTMLCanvasElement>("#drawingCanvas"),
  minimap: requiredElement<HTMLCanvasElement>("#minimapCanvas"),
  hint: requiredElement<HTMLElement>("#canvasHint"),
  coordinateReadout: requiredElement<HTMLElement>("#coordinateReadout"),
  strokeCount: requiredElement<HTMLElement>("#strokeCount"),
  nodeCount: requiredElement<HTMLElement>("#nodeCount"),
  weight: requiredElement<HTMLInputElement>("#weight"),
  weightValue: requiredElement<HTMLOutputElement>("#weightValue"),
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

function render(redrawTree = true, redrawMinimap = redrawTree): void {
  if (redrawTree) {
    const viewport = renderer.viewportBounds(camera);
    visibleCells = store.visibleIn(viewport);
    visibleDebugRegions = debugQuadtree ? store.debugLeavesIn(viewport) : [];
  }

  renderer.render(camera, visibleCells, visibleDebugRegions, redrawTree);
  if (redrawMinimap) {
    renderer.renderMinimap(camera, store.allCells());
  }
  updateStatus();
}

function updateStatus(): void {
  elements.strokeCount.textContent = String(store.strokeCount);
  elements.nodeCount.textContent = String(store.nodeCount);
  elements.zoomLevel.textContent = `${Math.round(camera.zoom * 100)}%`;
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

function renderViewportPreview(): void {
  render(false);
  window.clearTimeout(viewportSettleTimer);
  viewportSettleTimer = window.setTimeout(() => render(true), 120);
}

function beginDrawing(point: Point): void {
  currentAction = store.createStroke(point, activeColor, Number(elements.weight.value));
  elements.hint.style.opacity = "0";
  render(true, false);
}

function finishInteraction(): void {
  if (currentAction) {
    store.commit(currentAction);
    currentAction = null;
  }

  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-panning");
  window.clearTimeout(viewportSettleTimer);
  render();
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
    const point = renderer.screenToWorld(event, camera);
    elements.coordinateReadout.textContent = `X: ${Math.round(point.x)}   Y: ${Math.round(point.y)}`;

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
      const zoomFactor = event.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;

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
