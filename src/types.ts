export type Point = {
  x: number;
  y: number;
  /** DOM high-resolution timestamp, used for velocity-derived brush dynamics. */
  time?: number;
  /** Native stylus pressure from 0 to 1. Undefined for mouse and touch input. */
  pressure?: number;
  /** Smoothed velocity- and pressure-adjusted brush width at this input sample. */
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

export type Tool = "select" | "lasso" | "pen" | "eraser" | "hand";
export type BrushTexture = "solid" | "bristle" | "charcoal";

/** Ephemeral pointer input. It is never rendered or persisted as a path. */
export type BrushAction = {
  kind: "stroke" | "eraser";
  points: Point[];
  color: string;
  width: number;
  /** How strongly velocity and pressure affect stroke thickness, from 0 to 1. */
  dynamics: number;
  /** Brush pigment density, expressed as a normalized opacity from 0 to 1. */
  density: number;
  texture: BrushTexture;
  /** Keeps the mask phase and orientation stable for the lifetime of this gesture. */
  textureSeed: number;
  /** Distance travelled through the repeating 2D brush-tip mask. */
  textureOffset: number;
  /** Number of transient input intervals already baked into the quadtree. */
  rasterizedSegments: number;
};

/**
 * Streams renderable cells without allocating a cell object per leaf. The hot
 * render path feeds these coordinates straight into a GPU instance buffer.
 */
export type RenderCellVisitor = (
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
) => void;

/** A directly renderable, uniformly colored quadtree region. */
export type RasterCell = {
  bounds: Bounds;
  color: number;
  /** Paint-order group used to batch cells without merging overlapping layers. */
  renderGroup?: number;
};

/** An occupied leaf with its stable address in one immutable quadtree version. */
export type RasterSelectionCell = RasterCell & {
  address: number;
};

/**
 * Complete connected ink islands resolved from a selection shape. Produced
 * only transiently, at the moment a select-and-move drag begins.
 */
export type RasterSelection = {
  cells: RasterSelectionCell[];
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
