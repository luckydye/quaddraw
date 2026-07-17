export type Point = {
  x: number;
  y: number;
  /** DOM high-resolution timestamp, used to simulate pen pressure from velocity. */
  time?: number;
  /** Smoothed velocity-derived brush width, captured when this point is added. */
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

export type Stroke = {
  id: number;
  kind: "stroke" | "eraser";
  points: Point[];
  color: string;
  width: number;
  /** Edge feathering captured when the path is created. */
  softness?: number;
  /** Final, immutable render geometry written when the stroke is committed. */
  segments?: CubicSegment[];
  bounds: Bounds;
};

export type CubicSegment = {
  start: Point;
  controlOne: Point;
  controlTwo: Point;
  end: Point;
  width: number;
};

export const WORLD_BOUNDS: Bounds = {
  x: -10_000,
  y: -10_000,
  width: 20_000,
  height: 20_000,
};

export function boundsFromPoints(points: Point[], lineWidth: number): Bounds {
  const padding = lineWidth + 3;
  const xValues = points.map((point) => point.x);
  const yValues = points.map((point) => point.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);

  return {
    x: minX - padding,
    y: minY - padding,
    width: maxX - minX + padding * 2,
    height: maxY - minY + padding * 2,
  };
}

export function boundsAround(point: Point, radius: number): Bounds {
  return {
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2,
  };
}
