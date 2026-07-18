export type Point = {
  x: number;
  y: number;
  /** DOM high-resolution timestamp, used for velocity-derived brush dynamics. */
  time?: number;
  /** Native stylus pressure from 0 to 1. Undefined for mouse and touch input. */
  pressure?: number;
  /** Smoothed velocity-derived brush width at this input sample. */
  strength?: number;
};

export type Bounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type Tool = "select" | "pen" | "eraser" | "hand";
export type BrushTexture = "solid" | "charcoal";

/** Ephemeral pointer input. It is never rendered or persisted as a path. */
export type BrushAction = {
  kind: "stroke" | "eraser";
  points: Point[];
  color: string;
  width: number;
  /** Brush pigment density, expressed as a normalized opacity from 0 to 1. */
  density: number;
  texture: BrushTexture;
  /** Keeps procedural grain stable for the lifetime of this gesture. */
  textureSeed: number;
  /** Number of transient input intervals already baked into the quadtree. */
  rasterizedSegments: number;
};

/** A directly renderable, uniformly colored quadtree region. */
export type RasterCell = {
  bounds: Bounds;
  color: number;
};

/** Complete connected ink islands selected by a point or marquee query. */
export type RasterSelection = {
  cells: RasterCell[];
  bounds: Bounds;
  islandCount: number;
};

/** A quadtree leaf exposed only for topology visualization. */
export type QuadDebugRegion = {
  bounds: Bounds;
  depth: number;
  occupied: boolean;
};

export const WORLD_BOUNDS: Bounds = {
  x: -10_000,
  y: -10_000,
  width: 20_000,
  height: 20_000,
};
