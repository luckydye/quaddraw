import { WebGPURenderer } from "./webgpu-renderer";
import { ColorPickerElement } from "./color-picker";
import {
  cameraAfterGesture,
  gestureFrame,
  type GestureFrame,
} from "./canvas-navigation";
import { DrawingStore } from "./drawing-store";
import { pointInPolygon } from "./quadtree";
import type {
  Bounds,
  BrushAction,
  BrushTexture,
  Camera,
  Point,
  QuadDebugRegion,
  RasterSelection,
  Tool,
} from "./types";

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 16;
const ZOOM_BUTTON_FACTOR = 1.2;
const PINCH_ZOOM_SENSITIVITY = 0.01;
const MAX_WHEEL_DELTA = 120;
const ERASER_WIDTH = 28;
// A two-finger tap undoes: brief, near-still, without a third finger.
const TWO_FINGER_TAP_MAX_DURATION = 300;
const TWO_FINGER_TAP_MAX_MOVEMENT = 12;

const BRUSH_PRESETS = {
  ink: { label: "Ink", density: 100, dynamics: 100, texture: "solid" },
  bristle: { label: "Bristle", density: 100, dynamics: 75, texture: "bristle" },
  charcoal: { label: "Charcoal", density: 72, dynamics: 85, texture: "charcoal" },
} as const satisfies Record<string, {
  label: string;
  density: number;
  dynamics: number;
  texture: BrushTexture;
}>;

type BrushPresetId = keyof typeof BRUSH_PRESETS;

if (!customElements.get("a-color-picker")) {
  customElements.define("a-color-picker", ColorPickerElement);
}

const elements = {
  area: requiredElement<HTMLElement>("#canvasArea"),
  canvas: requiredElement<HTMLCanvasElement>("#drawingCanvas"),
  debugFlashCanvas: requiredElement<HTMLCanvasElement>("#debugFlashCanvas"),
  brushCursor: requiredElement<HTMLElement>("#brushCursor"),
  brushColor: requiredElement<ColorPickerElement>("#brushColor"),
  minimap: requiredElement<HTMLCanvasElement>("#minimapCanvas"),
  hint: requiredElement<HTMLElement>("#canvasHint"),
  strokeCount: requiredElement<HTMLElement>("#strokeCount"),
  nodeCount: requiredElement<HTMLElement>("#nodeCount"),
  occupiedResolution: requiredElement<HTMLElement>("#occupiedResolution"),
  snapshotCompressedSize: requiredElement<HTMLElement>("#snapshotCompressedSize"),
  snapshotUncompressedSize: requiredElement<HTMLElement>("#snapshotUncompressedSize"),
  weight: requiredElement<HTMLInputElement>("#weight"),
  weightValue: requiredElement<HTMLOutputElement>("#weightValue"),
  density: requiredElement<HTMLInputElement>("#density"),
  densityValue: requiredElement<HTMLOutputElement>("#densityValue"),
  dynamics: requiredElement<HTMLInputElement>("#dynamics"),
  dynamicsValue: requiredElement<HTMLOutputElement>("#dynamicsValue"),
  brushTexture: requiredElement<HTMLSelectElement>("#brushTexture"),
  brushSettingsValue: requiredElement<HTMLElement>("#brushSettingsValue"),
  inspector: requiredElement<HTMLElement>("#inspector"),
  layerList: requiredElement<HTMLElement>("#layerList"),
  layerOpacity: requiredElement<HTMLInputElement>("#layerOpacity"),
  layerOpacityValue: requiredElement<HTMLOutputElement>("#layerOpacityValue"),
  layerMoveUp: requiredElement<HTMLButtonElement>("#layerMoveUp"),
  layerMoveDown: requiredElement<HTMLButtonElement>("#layerMoveDown"),
  addLayer: requiredElement<HTMLButtonElement>("#addLayer"),
  removeLayer: requiredElement<HTMLButtonElement>("#removeLayer"),
  zoomLevel: requiredElement<HTMLButtonElement>("#zoomLevel"),
  debugTree: requiredElement<HTMLButtonElement>("#debugTree"),
  toast: requiredElement<HTMLElement>("#toast"),
};

const store = new DrawingStore();
const renderer = new WebGPURenderer(
  elements.canvas,
  elements.debugFlashCanvas,
  elements.minimap,
  elements.area,
);

let camera: Camera = { x: 0, y: 0, zoom: 1 };
let activeTool: Tool = "pen";
let activeColor = "#393b42";
let currentAction: BrushAction | null = null;
let visibleDebugRegions: readonly QuadDebugRegion[] = [];
let renderedWorldBounds: Bounds | null = null;
let activeMoveSelection: RasterSelection | null = null;
let selectionStart: Point | null = null;
let selectionMarquee: Bounds | null = null;
let selectionLasso: Point[] | null = null;
let selectionMoveStart: Point | null = null;
let selectionOffset: Point = { x: 0, y: 0 };
let debugQuadtree = false;
let isPanning = false;
let isSpacePressed = false;
let lastPointerPosition: Point | null = null;
const touchPointers = new Map<number, Point>();
let touchNavigationActive = false;
let previousTouchGesture: GestureFrame | null = null;
let touchTapCandidate = false;
let touchGestureStart: GestureFrame | null = null;
let touchGestureStartTime = 0;
let touchMaxPointers = 0;
let viewportSettleTimer: number | undefined;
let textureSeed = Date.now() >>> 0;

function nextTextureSeed(): number {
  textureSeed = (textureSeed + 1) >>> 0;
  return textureSeed;
}

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Required UI element not found: ${selector}`);
  }
  return element;
}

function selectBrushPreset(presetId: BrushPresetId): void {
  const preset = BRUSH_PRESETS[presetId];
  elements.density.value = String(preset.density);
  elements.dynamics.value = String(preset.dynamics);
  elements.brushTexture.value = preset.texture;
  elements.densityValue.textContent = `${preset.density}%`;
  elements.dynamicsValue.textContent = `${preset.dynamics}%`;
  updateBrushPresetState();
}

function updateBrushCursor(): void {
  const density = Number(elements.density.value) / 100;
  const dynamics = Number(elements.dynamics.value) / 100;
  const screenSize = Number(elements.weight.value) * camera.zoom;
  const color = colorChannels(activeColor);

  elements.brushCursor.dataset.texture = elements.brushTexture.value;
  elements.brushCursor.toggleAttribute("data-small", screenSize <= 4);
  elements.brushCursor.style.setProperty("--brush-cursor-size", `${screenSize}px`);
  elements.brushCursor.style.setProperty(
    "--brush-cursor-fill",
    `rgb(${color.red} ${color.green} ${color.blue} / ${density * 0.16})`,
  );
  elements.brushCursor.style.setProperty(
    "--brush-cursor-dynamics-scale",
    String(1 - dynamics * 0.58),
  );
  elements.brushCursor.style.setProperty(
    "--brush-cursor-dynamics-opacity",
    String(dynamics * 0.55),
  );
}

function colorChannels(color: string): { red: number; green: number; blue: number } {
  const value = color.startsWith("#") ? color.slice(1) : color;
  const normalized = value.length === 3
    ? [...value].map((channel) => channel + channel).join("")
    : value;
  const parsed = Number.parseInt(normalized, 16);
  return {
    red: (parsed >> 16) & 0xff,
    green: (parsed >> 8) & 0xff,
    blue: parsed & 0xff,
  };
}

function updateBrushPresetState(): void {
  const density = Number(elements.density.value);
  const dynamics = Number(elements.dynamics.value);
  const texture = elements.brushTexture.value as BrushTexture;
  const activePreset = (Object.entries(BRUSH_PRESETS) as Array<[
    BrushPresetId,
    (typeof BRUSH_PRESETS)[BrushPresetId],
  ]>).find(([, preset]) => (
    preset.density === density
    && preset.dynamics === dynamics
    && preset.texture === texture
  ))?.[0];

  document.querySelectorAll<HTMLButtonElement>("[data-brush-preset]").forEach((button) => {
    const isSelected = button.dataset.brushPreset === activePreset;
    button.classList.toggle("selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
  elements.brushSettingsValue.textContent = activePreset
    ? BRUSH_PRESETS[activePreset].label
    : "Custom";
  updateBrushCursor();
}

// A full-viewport instanced GPU redraw is cheap, so every tree change simply
// re-gathers the visible cells and uploads them. Camera-only changes reuse the
// world-space instance buffer already on the GPU.
function render(redrawTree = true, redrawMinimap = redrawTree): void {
  if (redrawTree) {
    const scale = camera.zoom;
    const { bounds, coversAllInk } = treeRenderBounds();
    renderedWorldBounds = bounds;
    visibleDebugRegions = debugQuadtree ? store.debugLeavesIn(bounds, scale) : [];
    renderer.render(
      camera,
      (sink) => store.visitVisible(bounds, scale, sink),
      visibleDebugRegions,
      renderedWorldBounds,
      coversAllInk,
      store.selectionShape,
      activeMoveSelection,
      selectionMarquee,
      selectionLasso,
      selectionOffset,
    );
  } else {
    renderer.redraw(
      camera,
      store.selectionShape,
      activeMoveSelection,
      selectionMarquee,
      selectionLasso,
      selectionOffset,
    );
  }
  if (redrawMinimap) {
    renderer.renderMinimap(camera, store.allCells(renderer.overviewScale));
  }
  updateStatus();
}

// Live brush edits stay on the fixed drawing camera, so a viewport redraw picks
// up the freshly painted cells without any incremental cache bookkeeping.
function renderActionRegion(): void {
  store.consumeActionDirtyBounds();
  render(true, false);
}

// The GPU instance buffer is world-space, so panning at a fixed zoom only needs
// the cells already uploaded. When the whole drawing fits within a few
// viewports we gather all of it once and mark the frame as covering every ink
// cell, which lets panning skip rebuilds entirely instead of re-collecting the
// same cells each time the viewport nears the prefetched edge.
const PREFETCH_INK_VIEWPORT_MARGIN = 3;

function treeRenderBounds(): { bounds: Bounds; coversAllInk: boolean } {
  if (currentAction) {
    return { bounds: renderer.viewportBounds(camera), coversAllInk: false };
  }
  const margin = renderer.renderBounds(camera);
  const occupied = store.visibleOccupiedBounds();
  if (!occupied) return { bounds: margin, coversAllInk: true };
  const viewport = renderer.viewportBounds(camera);
  const fits = !debugQuadtree
    && occupied.width <= viewport.width * (1 + PREFETCH_INK_VIEWPORT_MARGIN * 2)
    && occupied.height <= viewport.height * (1 + PREFETCH_INK_VIEWPORT_MARGIN * 2);
  if (fits) return { bounds: unionBounds(margin, occupied), coversAllInk: true };
  return { bounds: margin, coversAllInk: containsBounds(margin, occupied) };
}

function unionBounds(a: Bounds, b: Bounds): Bounds {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function containsBounds(outer: Bounds, inner: Bounds): boolean {
  return inner.x >= outer.x
    && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

function renderActionOverview(bounds: Bounds): void {
  const padding = 3 / renderer.overviewScale;
  const renderBounds = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
  renderer.renderOverviewRegion(
    camera,
    store.visibleIn(renderBounds, renderer.overviewScale),
    renderBounds,
  );
}

function updateStatus(): void {
  setText(elements.strokeCount, String(store.strokeCount));
  setText(elements.nodeCount, String(store.nodeCount));
  const occupiedResolution = store.occupiedResolution;
  setText(
    elements.occupiedResolution,
    `${occupiedResolution.width.toLocaleString()} × ${occupiedResolution.height.toLocaleString()} px`,
  );
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

  updateBrushCursor();
  renderViewportPreview();
}

function wheelModeScale(event: WheelEvent): number {
  return event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? 16
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
      ? elements.area.clientHeight
      : 1;
}

function normalizedWheelDelta(event: WheelEvent): number {
  const pixelDelta = event.deltaY * wheelModeScale(event);
  return Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, pixelDelta));
}

function renderViewportPreview(): void {
  const viewport = renderer.viewportBounds(camera);
  if (renderer.hasCoverageFor(viewport)) {
    // The uploaded world-space cells still cover the viewport, so just redraw
    // them under the new camera — a uniform update, no tree walk or upload.
    render(false, false);
    // Rebuild a fresh, recentered set once we near the prefetched edge, but off
    // the input path via rAF so this pointermove stays cheap.
    if (renderer.needsCoverageRefresh(viewport)) scheduleCoverageRebuild();
  } else {
    // A fast fling outran the prefetch; rebuild now to avoid a blank edge.
    cancelCoverageRebuild();
    render(true, false);
  }
  window.clearTimeout(viewportSettleTimer);
  viewportSettleTimer = window.setTimeout(() => {
    cancelCoverageRebuild();
    render(true, true);
  }, 120);
}

let coverageRebuildHandle = 0;

function scheduleCoverageRebuild(): void {
  if (coverageRebuildHandle) return;
  coverageRebuildHandle = requestAnimationFrame(() => {
    coverageRebuildHandle = 0;
    render(true, false);
  });
}

function cancelCoverageRebuild(): void {
  if (!coverageRebuildHandle) return;
  cancelAnimationFrame(coverageRebuildHandle);
  coverageRebuildHandle = 0;
}

/** Clears the active selection, as its own undoable step. */
function deselect(): void {
  activeMoveSelection = null;
  store.setSelection(null);
}

function beginDrawing(point: Point): void {
  window.clearTimeout(viewportSettleTimer);
  cancelCoverageRebuild();
  currentAction = store.createStroke(
    point,
    activeColor,
    Number(elements.weight.value),
    Number(elements.density.value) / 100,
    elements.brushTexture.value as BrushTexture,
    nextTextureSeed(),
    Number(elements.dynamics.value) / 100,
  );
  elements.hint.style.opacity = "0";
  render(false, false);
}

function finishInteraction(completeSelection = true): void {
  const finishedPanning = isPanning && currentAction === null;
  const finishedDrawing = currentAction !== null;
  if (currentAction) {
    const actionBounds = store.activeActionBounds;
    if (completeSelection) {
      store.commit(currentAction);
      renderActionRegion();
    } else {
      store.cancelAction();
      renderActionRegion();
    }
    if (actionBounds) renderActionOverview(actionBounds);
    currentAction = null;
  }

  if (selectionMoveStart) {
    if (completeSelection && activeMoveSelection) {
      // moveSelection clears the selection itself, bundled into the same
      // undoable step as the move (see the "clears after move" behavior).
      const moved = store.moveSelection(activeMoveSelection, selectionOffset.x, selectionOffset.y);
      if (moved) {
        showToast(`Moved ${moved.islandCount} ink island${moved.islandCount === 1 ? "" : "s"}`);
      }
    }
    activeMoveSelection = null;
    selectionMoveStart = null;
    selectionOffset = { x: 0, y: 0 };
  }

  if (selectionStart) {
    if (completeSelection) {
      const bounds = selectionMarquee ?? boundsFromPoints(selectionStart, selectionStart);
      if (bounds.width > 0 && bounds.height > 0) {
        store.setSelection(polygonFromBounds(bounds));
      } else {
        deselect();
      }
    }
    selectionStart = null;
    selectionMarquee = null;
  }

  if (selectionLasso) {
    if (completeSelection) {
      if (selectionLasso.length >= 3) {
        store.setSelection(selectionLasso);
      } else {
        deselect();
      }
    }
    selectionLasso = null;
  }

  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-panning");
  elements.area.classList.remove("is-moving-selection");
  window.clearTimeout(viewportSettleTimer);
  cancelCoverageRebuild();
  if (finishedDrawing) {
    updateStatus();
    return;
  }
  render(true, true);
}

function cancelToolInteraction(): void {
  if (currentAction) {
    store.cancelAction();
    currentAction = null;
  }
  selectionMoveStart = null;
  selectionStart = null;
  selectionMarquee = null;
  selectionLasso = null;
  selectionOffset = { x: 0, y: 0 };
  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-moving-selection");
}

function beginTouchNavigation(): void {
  cancelToolInteraction();
  touchNavigationActive = true;
  previousTouchGesture = gestureFrame(touchPointers.values());
  touchGestureStart = previousTouchGesture;
  touchGestureStartTime = Date.now();
  touchTapCandidate = true;
  touchMaxPointers = touchPointers.size;
  isPanning = true;
  elements.area.classList.add("is-panning");
  // A second finger may interrupt a brush preview. Rebuild once from the
  // restored document before cheap camera-only previews take over.
  render(true, false);
}

function updateTouchNavigation(): void {
  const nextGesture = gestureFrame(touchPointers.values());
  if (!nextGesture || !previousTouchGesture) {
    previousTouchGesture = nextGesture;
    return;
  }

  if (touchTapCandidate && touchGestureStart) {
    const movedCenter = Math.hypot(
      nextGesture.center.x - touchGestureStart.center.x,
      nextGesture.center.y - touchGestureStart.center.y,
    );
    const pinched = Math.abs(nextGesture.distance - touchGestureStart.distance);
    if (movedCenter > TWO_FINGER_TAP_MAX_MOVEMENT || pinched > TWO_FINGER_TAP_MAX_MOVEMENT) {
      touchTapCandidate = false;
    }
  }

  const canvasBounds = elements.canvas.getBoundingClientRect();
  const previous = {
    ...previousTouchGesture,
    center: {
      x: previousTouchGesture.center.x - canvasBounds.left,
      y: previousTouchGesture.center.y - canvasBounds.top,
    },
  };
  const next = {
    ...nextGesture,
    center: {
      x: nextGesture.center.x - canvasBounds.left,
      y: nextGesture.center.y - canvasBounds.top,
    },
  };
  camera = cameraAfterGesture(camera, previous, next, ZOOM_MIN, ZOOM_MAX);
  previousTouchGesture = nextGesture;
  updateBrushCursor();
  renderViewportPreview();
}

function finishTouchNavigation(): void {
  const wasTap = touchTapCandidate
    && Date.now() - touchGestureStartTime <= TWO_FINGER_TAP_MAX_DURATION;
  const tapFingers = touchMaxPointers;
  touchNavigationActive = false;
  previousTouchGesture = null;
  touchTapCandidate = false;
  touchGestureStart = null;
  touchMaxPointers = 0;
  isPanning = false;
  elements.area.classList.remove("is-panning");
  window.clearTimeout(viewportSettleTimer);
  cancelCoverageRebuild();
  if (wasTap) {
    // Two fingers undo, three redo — the inverse pair on the same gesture.
    if (tapFingers === 2 && performUndo(true)) return;
    if (tapFingers === 3 && performRedo(true)) return;
  }
  render(true, true);
}

function performUndo(flashButton = false): boolean {
  if (!store.undo()) return false;
  activeMoveSelection = null;
  render();
  renderLayerPanel();
  if (flashButton) flashToolButton("#undo");
  return true;
}

function performRedo(flashButton = false): boolean {
  if (!store.redo()) return false;
  activeMoveSelection = null;
  render();
  renderLayerPanel();
  if (flashButton) flashToolButton("#redo");
  return true;
}

/** Draws attention to a toolbar button when its action is triggered elsewhere. */
function flashToolButton(selector: string): void {
  const button = requiredElement<HTMLButtonElement>(selector);
  button.classList.remove("flash");
  // Force a reflow so re-adding the class restarts the animation.
  void button.offsetWidth;
  button.classList.add("flash");
}

function boundsFromPoints(first: Point, second: Point): Bounds {
  const x = Math.min(first.x, second.x);
  const y = Math.min(first.y, second.y);
  return {
    x,
    y,
    width: Math.max(first.x, second.x) - x,
    height: Math.max(first.y, second.y) - y,
  };
}

function polygonFromBounds(bounds: Bounds): Point[] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ];
}

function showToast(message: string): void {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.setTimeout(() => elements.toast.classList.remove("show"), 1_800);
}

function renderLayerPanel(): void {
  const layers = [...store.layers];
  const activeIndex = layers.findIndex(({ id }) => id === store.activeLayerId);
  const activeLayer = layers[activeIndex];
  const rows = [...layers].reverse().map((layer) => {
    const row = document.createElement("div");
    row.className = "layer-row";
    row.classList.toggle("active", layer.id === store.activeLayerId);
    row.dataset.layerId = String(layer.id);
    row.tabIndex = 0;
    row.setAttribute("role", "option");
    row.setAttribute("aria-selected", String(layer.id === store.activeLayerId));
    row.addEventListener("click", () => activateLayer(layer.id));
    row.addEventListener("keydown", (event) => {
      if (event.target !== row || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      activateLayer(layer.id);
    });

    const visibility = document.createElement("button");
    visibility.type = "button";
    visibility.className = "layer-visibility";
    visibility.classList.toggle("is-hidden", !layer.visible);
    visibility.textContent = layer.visible ? "●" : "○";
    visibility.title = layer.visible ? "Hide layer" : "Show layer";
    visibility.setAttribute("aria-label", `${layer.visible ? "Hide" : "Show"} ${layer.name}`);
    visibility.setAttribute("aria-pressed", String(layer.visible));
    visibility.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!store.setLayerVisibility(layer.id, !layer.visible)) return;
      activeMoveSelection = null;
      render();
      renderLayerPanel();
    });

    const thumbnail = document.createElement("span");
    thumbnail.className = "layer-thumbnail";
    thumbnail.setAttribute("aria-hidden", "true");

    const name = document.createElement("input");
    name.className = "layer-name";
    name.value = layer.name;
    name.spellcheck = false;
    name.setAttribute("aria-label", `Layer name: ${layer.name}`);
    name.addEventListener("click", (event) => event.stopPropagation());
    name.addEventListener("focus", () => {
      if (layer.id !== store.activeLayerId) activateLayer(layer.id, true);
    });
    name.addEventListener("change", () => {
      store.renameLayer(layer.id, name.value);
      renderLayerPanel();
    });
    name.addEventListener("keydown", (event) => {
      if (event.key === "Enter") name.blur();
      if (event.key === "Escape") {
        name.value = layer.name;
        name.blur();
      }
    });

    row.append(visibility, thumbnail, name);
    return row;
  });
  elements.layerList.replaceChildren(...rows);

  const opacity = activeLayer ? Math.round(activeLayer.opacity * 100) : 100;
  elements.layerOpacity.value = String(opacity);
  elements.layerOpacityValue.value = `${opacity}%`;
  elements.layerMoveUp.disabled = activeIndex < 0 || activeIndex === layers.length - 1;
  elements.layerMoveDown.disabled = activeIndex <= 0;
  elements.removeLayer.disabled = layers.length <= 1;
}

function activateLayer(layerId: number, focusName = false): void {
  const changed = store.setActiveLayer(layerId);
  if (changed) {
    activeMoveSelection = null;
    render(debugQuadtree, false);
    renderLayerPanel();
  }
  if (focusName) {
    queueMicrotask(() => {
      const input = elements.layerList.querySelector<HTMLInputElement>(
        `.layer-row[data-layer-id="${layerId}"] .layer-name`,
      );
      input?.focus();
      input?.select();
    });
  }
}

function renderAfterLayerChange(message?: string): void {
  activeMoveSelection = null;
  render();
  renderLayerPanel();
  if (message) showToast(message);
}

function bindCanvasEvents(): void {
  const positionBrushCursor = (event: PointerEvent): void => {
    if (event.pointerType === "touch") {
      elements.area.classList.remove("has-brush-pointer");
      return;
    }
    elements.brushCursor.style.setProperty("--brush-cursor-x", `${event.offsetX}px`);
    elements.brushCursor.style.setProperty("--brush-cursor-y", `${event.offsetY}px`);
    elements.area.classList.add("has-brush-pointer");
  };
  elements.canvas.addEventListener("pointerenter", positionBrushCursor);
  elements.canvas.addEventListener("pointermove", positionBrushCursor);
  elements.canvas.addEventListener("pointerleave", () => {
    elements.area.classList.remove("has-brush-pointer");
  });

  // Middle-button mouse-down would otherwise start the browser's autoscroll.
  elements.canvas.addEventListener("mousedown", (event) => {
    if (event.button === 1) event.preventDefault();
  });

  elements.canvas.addEventListener("pointerdown", (event) => {
    const middleButtonPan = event.pointerType === "mouse" && event.button === 1;
    if (event.pointerType === "mouse" && event.button !== 0 && !middleButtonPan) return;
    elements.canvas.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointers.size >= 2 && !touchNavigationActive) beginTouchNavigation();
      touchMaxPointers = Math.max(touchMaxPointers, touchPointers.size);
      if (touchNavigationActive) return;
    }

    // The middle button pans from any tool without disturbing its state.
    if (middleButtonPan) {
      isPanning = true;
      elements.area.classList.add("is-panning");
      lastPointerPosition = { x: event.clientX, y: event.clientY };
      return;
    }

    const point = renderer.screenToWorld(event, camera);
    lastPointerPosition = { x: event.clientX, y: event.clientY };

    if ((activeTool === "select" || activeTool === "lasso") && !isSpacePressed) {
      const shape = store.selectionShape;
      if (shape && pointInPolygon(point, shape)) {
        const previousLayerId = store.activeLayerId;
        const resolved = store.selectConnectedIslandsInPolygon(shape);
        if (store.activeLayerId !== previousLayerId) renderLayerPanel();
        if (resolved) {
          activeMoveSelection = resolved;
          selectionMoveStart = point;
          selectionOffset = { x: 0, y: 0 };
          elements.area.classList.add("is-moving-selection");
          return;
        }
      }
      deselect();
      if (activeTool === "lasso") selectionLasso = [point];
      else {
        selectionStart = point;
        selectionMarquee = boundsFromPoints(point, point);
      }
      render(false, false);
      return;
    }

    if (activeTool === "pen" && !isSpacePressed) {
      beginDrawing(point);
      return;
    }

    if (activeTool === "eraser" && !isSpacePressed) {
      window.clearTimeout(viewportSettleTimer);
      cancelCoverageRebuild();
      currentAction = store.createEraser(point, ERASER_WIDTH);
      renderActionRegion();
      return;
    }

    if (activeTool === "hand" || isSpacePressed) {
      isPanning = true;
      elements.area.classList.add("is-panning");
    }
  });

  elements.canvas.addEventListener("pointermove", (event) => {
    if (event.pointerType === "touch" && touchPointers.has(event.pointerId)) {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchNavigationActive) {
        updateTouchNavigation();
        return;
      }
    }

    if (selectionMoveStart && activeMoveSelection) {
      const point = renderer.screenToWorld(event, camera);
      selectionOffset = store.snapSelectionMovement(
        activeMoveSelection,
        point.x - selectionMoveStart.x,
        point.y - selectionMoveStart.y,
      );
      render(false, false);
      return;
    }

    if (selectionStart) {
      selectionMarquee = boundsFromPoints(selectionStart, renderer.screenToWorld(event, camera));
      render(false, false);
      return;
    }

    if (selectionLasso) {
      const point = renderer.screenToWorld(event, camera);
      const previous = selectionLasso[selectionLasso.length - 1];
      if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 2 / camera.zoom) {
        selectionLasso.push(point);
        render(false, false);
      }
      return;
    }

    if (currentAction) {
      const coalescedEvents = event.getCoalescedEvents?.() ?? [event];
      store.appendPoints(
        currentAction,
        coalescedEvents.map((coalescedEvent) => (
          renderer.screenToWorld(coalescedEvent, camera)
        )),
      );
      renderActionRegion();
      return;
    }

    if (isPanning && lastPointerPosition) {
      camera.x += event.clientX - lastPointerPosition.x;
      camera.y += event.clientY - lastPointerPosition.y;
      lastPointerPosition = { x: event.clientX, y: event.clientY };
      renderViewportPreview();
    }
  });

  const finishPointer = (event: PointerEvent, completeInteraction: boolean): void => {
    if (event.pointerType !== "touch") {
      finishInteraction(completeInteraction);
      return;
    }

    touchPointers.delete(event.pointerId);
    if (touchNavigationActive) {
      if (touchPointers.size >= 2) {
        previousTouchGesture = gestureFrame(touchPointers.values());
      } else if (touchPointers.size === 0) {
        finishTouchNavigation();
      }
      return;
    }
    finishInteraction(completeInteraction);
  };

  elements.canvas.addEventListener("pointerup", (event) => finishPointer(event, true));
  elements.canvas.addEventListener("pointercancel", (event) => finishPointer(event, false));

  elements.area.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      if (!event.ctrlKey) {
        const modeScale = wheelModeScale(event);
        camera.x -= event.deltaX * modeScale;
        camera.y -= event.deltaY * modeScale;
        renderViewportPreview();
        return;
      }

      const canvasBounds = elements.canvas.getBoundingClientRect();
      const focusPoint = {
        x: event.clientX - canvasBounds.left,
        y: event.clientY - canvasBounds.top,
      };
      const zoomFactor = Math.exp(-normalizedWheelDelta(event) * PINCH_ZOOM_SENSITIVITY);

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
  elements.inspector.addEventListener("wheel", (event) => event.stopPropagation());

  elements.weight.addEventListener("input", () => {
    elements.weightValue.textContent = `${elements.weight.value} px`;
    updateBrushCursor();
  });

  elements.density.addEventListener("input", () => {
    elements.densityValue.textContent = `${elements.density.value}%`;
    updateBrushPresetState();
  });

  elements.dynamics.addEventListener("input", () => {
    elements.dynamicsValue.textContent = `${elements.dynamics.value}%`;
    updateBrushPresetState();
  });

  elements.brushTexture.addEventListener("change", updateBrushPresetState);

  document.querySelectorAll<HTMLButtonElement>("[data-brush-preset]").forEach((button) => {
    button.addEventListener("click", () => {
      const presetId = button.dataset.brushPreset as BrushPresetId;
      if (presetId in BRUSH_PRESETS) selectBrushPreset(presetId);
    });
  });

  elements.layerOpacity.addEventListener("input", () => {
    elements.layerOpacityValue.value = `${elements.layerOpacity.value}%`;
  });
  elements.layerOpacity.addEventListener("change", () => {
    if (store.setLayerOpacity(store.activeLayerId, Number(elements.layerOpacity.value) / 100)) {
      renderAfterLayerChange();
    }
  });

  elements.addLayer.addEventListener("click", () => {
    const layerId = store.addLayer();
    renderAfterLayerChange("Layer added");
    queueMicrotask(() => {
      const input = elements.layerList.querySelector<HTMLInputElement>(
        `.layer-row[data-layer-id="${layerId}"] .layer-name`,
      );
      input?.focus();
      input?.select();
    });
  });

  elements.removeLayer.addEventListener("click", () => {
    if (store.removeLayer(store.activeLayerId)) renderAfterLayerChange("Layer deleted");
  });

  elements.layerMoveUp.addEventListener("click", () => {
    const index = store.layers.findIndex(({ id }) => id === store.activeLayerId);
    if (store.moveLayer(store.activeLayerId, index + 1)) renderAfterLayerChange();
  });

  elements.layerMoveDown.addEventListener("click", () => {
    const index = store.layers.findIndex(({ id }) => id === store.activeLayerId);
    if (store.moveLayer(store.activeLayerId, index - 1)) renderAfterLayerChange();
  });

  const updateBrushColor = () => {
    activeColor = elements.brushColor.value;
    updateBrushCursor();
  };
  elements.brushColor.addEventListener("input", updateBrushColor);
  elements.brushColor.addEventListener("change", updateBrushColor);

  requiredElement<HTMLButtonElement>("#zoomIn").addEventListener("click", () => {
    updateCameraZoom(camera.zoom * ZOOM_BUTTON_FACTOR);
  });

  requiredElement<HTMLButtonElement>("#zoomOut").addEventListener("click", () => {
    updateCameraZoom(camera.zoom / ZOOM_BUTTON_FACTOR);
  });

  requiredElement<HTMLButtonElement>("#undo").addEventListener("click", () => {
    performUndo();
  });

  requiredElement<HTMLButtonElement>("#redo").addEventListener("click", () => {
    performRedo();
  });

  requiredElement<HTMLButtonElement>("#clearButton").addEventListener("click", () => {
    activeMoveSelection = null;
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
    if (isEditableControl(event.target)) return;
    if (event.code === "Space") {
      isSpacePressed = true;
      elements.area.classList.add("is-panning");
    }

    if (event.key.toLowerCase() === "p") selectTool("pen");
    if (event.key.toLowerCase() === "e") selectTool("eraser");
    if (event.key.toLowerCase() === "h") selectTool("hand");
    if (event.key.toLowerCase() === "l" && !event.metaKey && !event.ctrlKey) selectTool("lasso");
    if (
      event.key === "Escape"
      && (store.selectionShape || activeMoveSelection || selectionMarquee || selectionLasso || selectionMoveStart)
    ) {
      deselect();
      selectionStart = null;
      selectionMarquee = null;
      selectionLasso = null;
      selectionMoveStart = null;
      selectionOffset = { x: 0, y: 0 };
      elements.area.classList.remove("is-moving-selection");
      render(false, false);
    }
    if (event.key.toLowerCase() === "q" && !event.metaKey && !event.ctrlKey && !event.repeat) {
      toggleQuadtreeDebug();
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        performRedo(true);
      } else {
        performUndo(true);
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

function isEditableControl(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && target.closest("#inspector, input, textarea, select, button, [contenteditable='true']") !== null;
}

async function initialize(): Promise<void> {
  await store.restore();
  try {
    await renderer.init();
  } catch (error) {
    console.error(error);
    elements.hint.textContent = error instanceof Error
      ? error.message
      : "This browser does not support WebGPU.";
    elements.hint.style.opacity = "1";
    return;
  }
  store.subscribeSnapshotSize(updateStatus);
  bindCanvasEvents();
  bindControls();
  bindKeyboardShortcuts();
  updateBrushCursor();
  renderLayerPanel();
  new ResizeObserver(() => {
    renderer.resize();
    render();
  }).observe(elements.area);
  renderer.resize();
  render();
}

void initialize();
