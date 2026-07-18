import { CanvasRenderer } from "./canvas-renderer";
import { ColorPickerElement } from "./color-picker";
import {
  cameraAfterGesture,
  gestureFrame,
  type GestureFrame,
} from "./canvas-navigation";
import { DrawingStore } from "./drawing-store";
import type {
  Bounds,
  BrushAction,
  BrushTexture,
  Camera,
  Point,
  QuadDebugRegion,
  RasterCell,
  RasterSelection,
  Tool,
} from "./types";

const ZOOM_MIN = 0.2;
const ZOOM_MAX = 16;
const ZOOM_BUTTON_FACTOR = 1.2;
const PINCH_ZOOM_SENSITIVITY = 0.01;
const MAX_WHEEL_DELTA = 120;
const ERASER_WIDTH = 28;

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
const renderer = new CanvasRenderer(
  elements.canvas,
  elements.debugFlashCanvas,
  elements.minimap,
  elements.area,
);

let camera: Camera = { x: 0, y: 0, zoom: 1 };
let activeTool: Tool = "pen";
let activeColor = "#393b42";
let currentAction: BrushAction | null = null;
let visibleCells: readonly RasterCell[] = [];
let visibleDebugRegions: readonly QuadDebugRegion[] = [];
let renderedWorldBounds: Bounds | null = null;
let selection: RasterSelection | null = null;
let selectionStart: Point | null = null;
let selectionMarquee: Bounds | null = null;
let selectionMoveStart: Point | null = null;
let selectionOffset: Point = { x: 0, y: 0 };
let debugQuadtree = false;
let isPanning = false;
let isSpacePressed = false;
let lastPointerPosition: Point | null = null;
const touchPointers = new Map<number, Point>();
let touchNavigationActive = false;
let previousTouchGesture: GestureFrame | null = null;
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

function render(redrawTree = true, redrawMinimap = redrawTree, offThread = false): void {
  syncRendererRasterRevision();
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
      () => {
        renderer.render(
          camera,
          visibleCells,
          visibleDebugRegions,
          false,
          renderedWorldBounds,
          selection,
          selectionMarquee,
          selectionOffset,
        );
        if (currentAction && store.activeActionBounds) {
          renderActionRegion(store.activeActionBounds);
        }
      },
    );
  renderer.render(
    camera,
    visibleCells,
    visibleDebugRegions,
    redrawTree && !workerAccepted,
    renderedWorldBounds,
    selection,
    selectionMarquee,
    selectionOffset,
  );
  if (redrawMinimap) {
    renderer.renderMinimap(camera, store.allCells(renderer.overviewScale));
  }
  updateStatus();
}

function renderActionRegion(bounds = store.consumeActionDirtyBounds()): void {
  if (!bounds) return;
  syncRendererRasterRevision();
  // Include the full averaged LOD cells touched by the edit at low zoom.
  const padding = 3 / camera.zoom;
  const renderBounds = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
  const cells = store.visibleIn(renderBounds, camera.zoom);
  const debugRegions = debugQuadtree ? store.debugLeavesIn(renderBounds, camera.zoom) : [];
  if (!renderer.renderTreeRegion(camera, cells, debugRegions, renderBounds)) {
    render(true, false, true);
    return;
  }
  updateStatus();
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
  syncRendererRasterRevision();
  for (const request of renderer.panTileRequests(camera)) {
    renderer.cachePanTile(
      camera,
      request,
      store.visibleIn(request.queryBounds, camera.zoom),
      debugQuadtree ? store.debugLeavesIn(request.queryBounds, camera.zoom) : [],
    );
  }
  // Cached same-zoom tiles cover panned-in areas immediately. Zoom previews
  // continue transforming the prior detail until their rebuild settles.
  render(false, false);
  window.clearTimeout(viewportSettleTimer);
  viewportSettleTimer = window.setTimeout(() => {
    render(true, true, true);
  }, 120);
}

function syncRendererRasterRevision(): void {
  renderer.setRasterRevision(
    store.visualRevision,
    debugQuadtree ? store.activeLayerId : null,
  );
}

function beginDrawing(point: Point): void {
  window.clearTimeout(viewportSettleTimer);
  selection = null;
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
      if (actionBounds) renderActionRegion(actionBounds);
    }
    if (actionBounds) renderActionOverview(actionBounds);
    currentAction = null;
  }

  if (selectionMoveStart) {
    if (completeSelection && selection) {
      selection = store.moveSelection(selection, selectionOffset.x, selectionOffset.y);
    }
    selectionMoveStart = null;
    selectionOffset = { x: 0, y: 0 };
  }

  if (selectionStart) {
    if (completeSelection) {
      const area = selectionHitArea(selectionMarquee ?? boundsFromPoints(selectionStart, selectionStart));
      const previousLayerId = store.activeLayerId;
      selection = store.selectConnectedIslands(area);
      if (store.activeLayerId !== previousLayerId) renderLayerPanel();
      if (selection) {
        showToast(`${selection.islandCount} ink island${selection.islandCount === 1 ? "" : "s"} selected`);
      }
    }
    selectionStart = null;
    selectionMarquee = null;
  }

  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-panning");
  elements.area.classList.remove("is-moving-selection");
  window.clearTimeout(viewportSettleTimer);
  if (finishedDrawing) {
    updateStatus();
    return;
  }
  render(true, true, finishedPanning || finishedDrawing);
}

function cancelToolInteraction(): void {
  if (currentAction) {
    store.cancelAction();
    currentAction = null;
  }
  selectionMoveStart = null;
  selectionStart = null;
  selectionMarquee = null;
  selectionOffset = { x: 0, y: 0 };
  isPanning = false;
  lastPointerPosition = null;
  elements.area.classList.remove("is-moving-selection");
}

function beginTouchNavigation(): void {
  cancelToolInteraction();
  touchNavigationActive = true;
  previousTouchGesture = gestureFrame(touchPointers.values());
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
  touchNavigationActive = false;
  previousTouchGesture = null;
  isPanning = false;
  elements.area.classList.remove("is-panning");
  window.clearTimeout(viewportSettleTimer);
  render(true, true, true);
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

function selectionHitArea(bounds: Bounds): Bounds {
  const minimumSize = 6 / camera.zoom;
  const width = Math.max(bounds.width, minimumSize);
  const height = Math.max(bounds.height, minimumSize);
  return {
    x: bounds.x - (width - bounds.width) / 2,
    y: bounds.y - (height - bounds.height) / 2,
    width,
    height,
  };
}

function pointInBounds(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x
    && point.y >= bounds.y
    && point.x <= bounds.x + bounds.width
    && point.y <= bounds.y + bounds.height;
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
      selection = null;
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
    selection = null;
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
  selection = null;
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

  elements.canvas.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    elements.canvas.setPointerCapture(event.pointerId);

    if (event.pointerType === "touch") {
      touchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touchPointers.size >= 2) beginTouchNavigation();
      if (touchNavigationActive) return;
    }

    const point = renderer.screenToWorld(event, camera);
    lastPointerPosition = { x: event.clientX, y: event.clientY };

    if (activeTool === "select" && !isSpacePressed) {
      if (selection && pointInBounds(point, selection.bounds)) {
        selectionMoveStart = point;
        selectionOffset = { x: 0, y: 0 };
        elements.area.classList.add("is-moving-selection");
        return;
      }
      selection = null;
      selectionStart = point;
      selectionMarquee = boundsFromPoints(point, point);
      render(false, false);
      return;
    }

    if (activeTool === "pen" && !isSpacePressed) {
      beginDrawing(point);
      return;
    }

    if (activeTool === "eraser" && !isSpacePressed) {
      window.clearTimeout(viewportSettleTimer);
      selection = null;
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

    if (selectionMoveStart && selection) {
      const point = renderer.screenToWorld(event, camera);
      selectionOffset = store.snapSelectionMovement(
        selection,
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

    if (currentAction) {
      const coalescedEvents = event.getCoalescedEvents?.() ?? [event];
      for (const coalescedEvent of coalescedEvents) {
        store.appendPoint(currentAction, renderer.screenToWorld(coalescedEvent, camera));
      }
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
    if (store.undo()) {
      selection = null;
      render();
      renderLayerPanel();
    }
  });

  requiredElement<HTMLButtonElement>("#redo").addEventListener("click", () => {
    if (store.redo()) {
      selection = null;
      render();
      renderLayerPanel();
    }
  });

  requiredElement<HTMLButtonElement>("#clearButton").addEventListener("click", () => {
    selection = null;
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
    if (event.key.toLowerCase() === "v" && !event.metaKey && !event.ctrlKey) selectTool("select");
    if (event.key === "Escape" && (selection || selectionMarquee || selectionMoveStart)) {
      selection = null;
      selectionStart = null;
      selectionMarquee = null;
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
      if (event.shiftKey ? store.redo() : store.undo()) {
        selection = null;
        render();
        renderLayerPanel();
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
