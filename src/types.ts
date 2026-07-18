export type Point = {
  x: number;
  y: number;
  /** DOM high-resolution timestamp, used to simulate pen pressure from velocity. */
  time?: number;
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

export type Tool = "pen" | "eraser" | "hand";

/** Ephemeral pointer input. It is never rendered or persisted as a path. */
export type BrushAction = {
  kind: "stroke" | "eraser";
  points: Point[];
  color: string;
  width: number;
};

/** A directly renderable, uniformly colored quadtree region. */
export type RasterCell = {
  bounds: Bounds;
  color: number;
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
