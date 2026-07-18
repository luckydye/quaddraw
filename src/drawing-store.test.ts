import { describe, expect, test } from "bun:test";
import { DrawingStore } from "./drawing-store";
import { WORLD_BOUNDS } from "./types";

describe("DrawingStore velocity initialization", () => {
  test("does not paint a pen stroke before its initial velocity is known", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#393b42", 10);

    expect(store.visibleIn(WORLD_BOUNDS)).toHaveLength(0);

    // A long pointer-down pause followed by sub-pixel jitter must not classify
    // the whole startup as a slow, thick stroke.
    store.appendPoint(action, { x: 0.5, y: 0, time: 100 });

    expect(store.visibleIn(WORLD_BOUNDS)).toHaveLength(0);
    expect(action.points[0].strength).toBeUndefined();

    store.appendPoint(action, { x: 20, y: 0, time: 110 });

    expect(store.visibleIn(WORLD_BOUNDS).length).toBeGreaterThan(0);
    expect(action.points[0].strength).toBe(action.points[1].strength);
    expect(action.points[1].strength).toBe(action.points[2].strength);
    expect(action.points[0].strength).toBeLessThan(action.width);
  });

  test("does not inflate the stroke from stationary endpoint jitter", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#8855d4", 10);
    store.appendPoint(action, { x: 0.5, y: 0, time: 100 });
    store.appendPoint(action, { x: 20, y: 0, time: 110 });
    const startupWidth = action.points[action.points.length - 1].strength!;
    const pointCount = action.points.length;

    for (let index = 1; index <= 20; index++) {
      store.appendPoint(action, { x: 20 + index * 0.01, y: 0, time: 110 + index * 16 });
    }

    expect(action.points).toHaveLength(pointCount);
    expect(action.points[action.points.length - 1].strength).toBe(startupWidth);

    for (let index = 1; index <= 10; index++) {
      store.appendPoint(action, { x: 20 + index * 0.5, y: 0, time: 500 + index * 100 });
    }

    expect(action.points[action.points.length - 1].strength!).toBeLessThan(action.width);
  });

  test("smooths a sudden velocity change across multiple samples", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#393b42", 10);
    store.appendPoint(action, { x: 20, y: 0, time: 10 });
    const fastWidth = action.points[action.points.length - 1].strength!;

    store.appendPoint(action, { x: 22, y: 0, time: 110 });
    const firstSlowWidth = action.points[action.points.length - 1].strength!;

    expect(firstSlowWidth).toBeGreaterThan(fastWidth);
    expect(firstSlowWidth - fastWidth).toBeLessThan(action.width * 0.12);
  });
});

describe("DrawingStore brush density", () => {
  test("forwards density into the rasterized stroke", () => {
    const store = new DrawingStore();
    const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#4c8deb", 100_000, 0.25);

    store.appendPoint(action, { x: 20, y: 0, time: 10 });
    store.appendPoint(action, { x: 40, y: 0, time: 20 });

    const cells = store.visibleIn(WORLD_BOUNDS);
    expect(cells).toHaveLength(1);
    expect(cells[0].color & 0xff).toBe(64);
  });
});

describe("DrawingStore stylus pressure", () => {
  test("samples pressure changes even while the pen is stationary", () => {
    const store = new DrawingStore();
    const action = store.createStroke(
      { x: 0, y: 0, time: 0, pressure: 0.1 },
      "#393b42",
      10,
    );
    store.appendPoint(action, { x: 20, y: 0, time: 10, pressure: 0.1 });
    const lightWidth = action.points[action.points.length - 1].strength!;

    store.appendPoint(action, { x: 20, y: 0, time: 20, pressure: 0.8 });

    expect(action.points).toHaveLength(3);
    expect(action.points[action.points.length - 1].strength!).toBeGreaterThan(lightWidth);
  });

  test("dynamics can disable velocity and pressure thickness changes", () => {
    const store = new DrawingStore();
    const action = store.createStroke(
      { x: 0, y: 0, time: 0, pressure: 0.1 },
      "#393b42",
      10,
      1,
      "solid",
      0,
      0,
    );

    store.appendPoint(action, { x: 20, y: 0, time: 100, pressure: 0.1 });
    store.appendPoint(action, { x: 40, y: 0, time: 101, pressure: 1 });

    expect(action.dynamics).toBe(0);
    expect(action.points.every((point) => point.strength === action.width)).toBe(true);
  });

  test("full dynamics produces a pronounced thickness range", () => {
    const store = new DrawingStore();
    const heavySlowStroke = store.createStroke(
      { x: 0, y: 0, time: 0, pressure: 1 },
      "#393b42",
      10,
    );
    store.appendPoint(heavySlowStroke, { x: 20, y: 0, time: 100, pressure: 1 });

    const lightFastStroke = store.createStroke(
      { x: 0, y: 20, time: 0, pressure: 0 },
      "#393b42",
      10,
    );
    store.appendPoint(lightFastStroke, { x: 20, y: 20, time: 10, pressure: 0 });

    expect(heavySlowStroke.points[0].strength!).toBeGreaterThan(25);
    expect(lightFastStroke.points[0].strength!).toBeLessThan(1);
  });
});

describe("DrawingStore selection movement", () => {
  test("records a move as one undoable history operation", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { requestIdleCallback: () => 0 },
    });

    try {
      const store = new DrawingStore();
      const action = store.createStroke({ x: 0, y: 0, time: 0 }, "#4c8deb", 8);
      store.commit(action);
      const selection = store.selectConnectedIslands({ x: -5, y: -5, width: 10, height: 10 })!;
      const offset = store.snapSelectionMovement(selection, 80, 30);

      const movedSelection = store.moveSelection(selection, offset.x, offset.y);

      expect(movedSelection).not.toBeNull();
      expect(movedSelection!.cells.length).toBeGreaterThan(0);
      expect(Number.isFinite(movedSelection!.bounds.x)).toBe(true);
      expect(store.selectConnectedIslands({ x: -5, y: -5, width: 10, height: 10 })).toBeNull();
      expect(store.undo()).toBe(true);
      expect(store.selectConnectedIslands({ x: -5, y: -5, width: 10, height: 10 })).not.toBeNull();
      expect(store.redo()).toBe(true);
      expect(store.selectConnectedIslands({ x: -5, y: -5, width: 10, height: 10 })).toBeNull();
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});

describe("DrawingStore layers", () => {
  test("edits only the active layer and composites visible layers bottom to top", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { requestIdleCallback: () => 0 },
    });

    try {
      const store = new DrawingStore();
      const bottomStroke = store.createStroke({ x: 0, y: 0 }, "#f35b4c", 10);
      store.commit(bottomStroke);
      const bottomLayerId = store.activeLayerId;
      const topLayerId = store.addLayer("Highlights");
      const topStroke = store.createStroke({ x: 0, y: 0 }, "#4c8deb", 10);
      store.commit(topStroke);

      expect(store.layers.map(({ id }) => id)).toEqual([bottomLayerId, topLayerId]);
      expect([...new Set(store.visibleIn(WORLD_BOUNDS).map(({ renderGroup }) => renderGroup))])
        .toEqual([bottomLayerId, topLayerId]);

      const eraser = store.createEraser({ x: 0, y: 0 }, 20);
      store.commit(eraser);
      expect([...new Set(
        store.visibleIn(WORLD_BOUNDS).map(({ renderGroup }) => renderGroup),
      )]).toEqual([bottomLayerId]);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });

  test("makes layer properties and structure undoable", () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { requestIdleCallback: () => 0 },
    });

    try {
      const store = new DrawingStore();
      const layerId = store.addLayer("Paint");
      expect(store.setLayerOpacity(layerId, 0.4)).toBe(true);
      expect(store.layers.find(({ id }) => id === layerId)?.opacity).toBe(0.4);
      expect(store.undo()).toBe(true);
      expect(store.layers.find(({ id }) => id === layerId)?.opacity).toBe(1);
      expect(store.undo()).toBe(true);
      expect(store.layers).toHaveLength(1);
      expect(store.redo()).toBe(true);
      expect(store.layers.map(({ name }) => name)).toEqual(["Layer 1", "Paint"]);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  });
});
