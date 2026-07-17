import type { CubicSegment, Point, Stroke } from "./types";

/** Freezes the visual geometry of a path before it enters the persistent tree. */
export function freezeStrokeGeometry(stroke: Stroke): void {
  if (stroke.points.length < 2) {
    stroke.segments = [];
    return;
  }

  stroke.segments = [];
  for (let index = 0; index < stroke.points.length - 1; index++) {
    const before = stroke.points[Math.max(0, index - 1)];
    const start = stroke.points[index];
    const end = stroke.points[index + 1];
    const after = stroke.points[Math.min(stroke.points.length - 1, index + 2)];
    const controls = catmullRomControls(before, start, end, after);

    stroke.segments.push({
      start: { x: start.x, y: start.y },
      controlOne: controls.first,
      controlTwo: controls.second,
      end: { x: end.x, y: end.y },
      width: stroke.kind === "eraser"
        ? stroke.width
        : ((start.strength ?? stroke.width) + (end.strength ?? stroke.width)) / 2,
    });
  }
}

function catmullRomControls(
  before: Point,
  start: Point,
  end: Point,
  after: Point,
): { first: Point; second: Point } {
  const controlScale = 0.5 / 6;
  return {
    first: {
      x: start.x + (end.x - before.x) * controlScale,
      y: start.y + (end.y - before.y) * controlScale,
    },
    second: {
      x: end.x - (after.x - start.x) * controlScale,
      y: end.y - (after.y - start.y) * controlScale,
    },
  };
}
