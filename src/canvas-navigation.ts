import type { Camera, Point } from "./types";

export type GestureFrame = {
  center: Point;
  distance: number;
};

export function gestureFrame(points: Iterable<Point>): GestureFrame | null {
  const [first, second] = [...points];
  if (!first || !second) return null;
  return {
    center: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
    distance: Math.hypot(second.x - first.x, second.y - first.y),
  };
}

/** Keeps the world point below the old gesture center below the new center. */
export function cameraAfterGesture(
  camera: Camera,
  previous: GestureFrame,
  next: GestureFrame,
  minimumZoom: number,
  maximumZoom: number,
): Camera {
  const distanceRatio = previous.distance > 0 ? next.distance / previous.distance : 1;
  const zoom = Math.min(maximumZoom, Math.max(minimumZoom, camera.zoom * distanceRatio));
  const zoomRatio = zoom / camera.zoom;
  return {
    x: next.center.x + (camera.x - previous.center.x) * zoomRatio,
    y: next.center.y + (camera.y - previous.center.y) * zoomRatio,
    zoom,
  };
}
