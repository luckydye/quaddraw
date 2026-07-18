import type { Bounds, Point, QuadDebugRegion, RasterCell } from "./types";

export type QuadNode =
  | { readonly color: number; readonly children?: undefined }
  | { readonly color?: undefined; readonly children: readonly [QuadNode, QuadNode, QuadNode, QuadNode] };

const TRANSPARENT = 0;
const MAX_DEPTH = 15;

/**
 * A persistent sparse raster. Every uniform region is one node; brush edges
 * subdivide down to roughly one world unit. Rendering consumes these nodes
 * directly instead of replaying vector paths.
 */
export class RasterQuadTree {
  constructor(
    public readonly bounds: Bounds,
    private readonly root: QuadNode = uniform(TRANSPARENT),
  ) {}

  paintSegment(
    start: Point,
    end: Point,
    startWidth: number,
    endWidth: number,
    color: string,
    erase = false,
  ): RasterQuadTree {
    const paintColor = colorFromHex(color);
    const startRadius = Math.max(startWidth / 2, 0.5);
    const endRadius = Math.max(endWidth / 2, 0.5);
    const nextRoot = paintNode(
      this.root,
      this.bounds,
      0,
      start,
      end,
      startRadius,
      endRadius,
      paintColor,
      erase,
    );
    return nextRoot === this.root ? this : new RasterQuadTree(this.bounds, nextRoot);
  }

  cellsIn(area: Bounds): RasterCell[] {
    const cells: RasterCell[] = [];
    collectCells(this.root, this.bounds, area, cells);
    return cells;
  }

  allCells(): RasterCell[] {
    return this.cellsIn(this.bounds);
  }

  debugLeavesIn(area: Bounds): QuadDebugRegion[] {
    const regions: QuadDebugRegion[] = [];
    collectDebugLeaves(this.root, this.bounds, area, 0, regions);
    return regions;
  }

  countNodes(): number {
    return countNodes(this.root);
  }

  snapshot(): QuadNode {
    return this.root;
  }

  static fromSnapshot(bounds: Bounds, root: QuadNode): RasterQuadTree {
    return new RasterQuadTree(bounds, root);
  }
}

export function rgbaToCss(color: number): string {
  const red = (color >>> 24) & 0xff;
  const green = (color >>> 16) & 0xff;
  const blue = (color >>> 8) & 0xff;
  const alpha = color & 0xff;
  return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
}

function paintNode(
  node: QuadNode,
  bounds: Bounds,
  depth: number,
  start: Point,
  end: Point,
  startRadius: number,
  endRadius: number,
  paintColor: number,
  erase: boolean,
): QuadNode {
  const maximumRadius = Math.max(startRadius, endRadius);
  const minimumDistance = Math.sqrt(distanceSquaredSegmentToRect(start, end, bounds));
  if (minimumDistance > maximumRadius + 0.5) {
    return node;
  }

  const maximumDistance = maximumCornerDistance(start, end, bounds);
  const minimumRadius = Math.min(startRadius, endRadius);
  if (maximumDistance <= Math.max(0, minimumRadius - 0.5)) {
    const replacement = erase ? TRANSPARENT : withAlpha(paintColor, 255);
    return node.color === replacement ? node : uniform(replacement);
  }

  if (depth >= MAX_DEPTH || (bounds.width <= 1 && bounds.height <= 1)) {
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const distance = Math.sqrt(distanceSquaredToSegment(center, start, end));
    const amount = segmentAmount(center, start, end);
    const localRadius = startRadius + (endRadius - startRadius) * amount;
    const coverage = clamp(localRadius + 0.5 - distance, 0, 1);
    if (coverage === 0) return node;
    const currentColor = node.color ?? representativeColor(node);
    const nextColor = composite(currentColor, paintColor, coverage, erase);
    return nextColor === currentColor ? node : uniform(nextColor);
  }

  const childBounds = splitBounds(bounds);
  const oldChildren = node.children ?? [node, node, node, node];
  const children = oldChildren.map((child, index) =>
    paintNode(
      child,
      childBounds[index],
      depth + 1,
      start,
      end,
      startRadius,
      endRadius,
      paintColor,
      erase,
    )
  ) as [QuadNode, QuadNode, QuadNode, QuadNode];

  if (children.every((child, index) => child === oldChildren[index])) {
    return node;
  }

  const firstColor = children[0].color;
  if (firstColor !== undefined && children.every((child) => child.color === firstColor)) {
    return uniform(firstColor);
  }

  return { children };
}

function collectCells(node: QuadNode, bounds: Bounds, area: Bounds, cells: RasterCell[]): void {
  if (!rectanglesIntersect(bounds, area)) return;

  if (node.color !== undefined) {
    if ((node.color & 0xff) !== 0) cells.push({ bounds, color: node.color });
    return;
  }

  const childBounds = splitBounds(bounds);
  node.children.forEach((child, index) => collectCells(child, childBounds[index], area, cells));
}

function collectDebugLeaves(
  node: QuadNode,
  bounds: Bounds,
  area: Bounds,
  depth: number,
  regions: QuadDebugRegion[],
): void {
  if (!rectanglesIntersect(bounds, area)) return;
  if (node.color !== undefined) {
    regions.push({ bounds, depth, occupied: (node.color & 0xff) !== 0 });
    return;
  }

  const childBounds = splitBounds(bounds);
  node.children.forEach((child, index) =>
    collectDebugLeaves(child, childBounds[index], area, depth + 1, regions)
  );
}

function countNodes(node: QuadNode): number {
  return 1 + (node.children?.reduce((total, child) => total + countNodes(child), 0) ?? 0);
}

function representativeColor(node: QuadNode): number {
  if (node.color !== undefined) return node.color;
  // This is only used if a restored tree is deeper than the configured raster
  // resolution. Averaging keeps such snapshots renderable without path data.
  const colors = node.children.map(representativeColor);
  const totals = colors.reduce(
    (sum, color) => {
      const alpha = color & 0xff;
      sum.red += ((color >>> 24) & 0xff) * alpha;
      sum.green += ((color >>> 16) & 0xff) * alpha;
      sum.blue += ((color >>> 8) & 0xff) * alpha;
      sum.alpha += alpha;
      return sum;
    },
    { red: 0, green: 0, blue: 0, alpha: 0 },
  );
  if (totals.alpha === 0) return TRANSPARENT;
  return packColor(
    Math.round(totals.red / totals.alpha),
    Math.round(totals.green / totals.alpha),
    Math.round(totals.blue / totals.alpha),
    Math.round(totals.alpha / 4),
  );
}

function composite(current: number, paint: number, coverage: number, erase: boolean): number {
  const currentAlpha = (current & 0xff) / 255;
  if (erase) {
    const alpha = Math.round(currentAlpha * (1 - coverage) * 255);
    return alpha === 0 ? TRANSPARENT : withAlpha(current, alpha);
  }

  const outputAlpha = coverage + currentAlpha * (1 - coverage);
  if (outputAlpha <= 0) return TRANSPARENT;
  const currentWeight = currentAlpha * (1 - coverage);
  const red = Math.round((((paint >>> 24) & 0xff) * coverage + ((current >>> 24) & 0xff) * currentWeight) / outputAlpha);
  const green = Math.round((((paint >>> 16) & 0xff) * coverage + ((current >>> 16) & 0xff) * currentWeight) / outputAlpha);
  const blue = Math.round((((paint >>> 8) & 0xff) * coverage + ((current >>> 8) & 0xff) * currentWeight) / outputAlpha);
  return packColor(red, green, blue, Math.round(outputAlpha * 255));
}

function colorFromHex(color: string): number {
  const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Unsupported brush color: ${color}`);
  return packColor(parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16), 255);
}

function packColor(red: number, green: number, blue: number, alpha: number): number {
  return (((red & 0xff) << 24) | ((green & 0xff) << 16) | ((blue & 0xff) << 8) | (alpha & 0xff)) >>> 0;
}

function withAlpha(color: number, alpha: number): number {
  return ((color & 0xffffff00) | (alpha & 0xff)) >>> 0;
}

function uniform(color: number): QuadNode {
  return { color: color >>> 0 };
}

function splitBounds(bounds: Bounds): [Bounds, Bounds, Bounds, Bounds] {
  const halfWidth = bounds.width / 2;
  const halfHeight = bounds.height / 2;
  return [
    { x: bounds.x, y: bounds.y, width: halfWidth, height: halfHeight },
    { x: bounds.x + halfWidth, y: bounds.y, width: halfWidth, height: halfHeight },
    { x: bounds.x, y: bounds.y + halfHeight, width: halfWidth, height: halfHeight },
    { x: bounds.x + halfWidth, y: bounds.y + halfHeight, width: halfWidth, height: halfHeight },
  ];
}

function maximumCornerDistance(start: Point, end: Point, bounds: Bounds): number {
  return Math.sqrt(Math.max(...rectangleCorners(bounds).map((corner) => distanceSquaredToSegment(corner, start, end))));
}

function distanceSquaredSegmentToRect(start: Point, end: Point, bounds: Bounds): number {
  if (pointInRect(start, bounds) || pointInRect(end, bounds)) return 0;
  const corners = rectangleCorners(bounds);
  const edges: [Point, Point][] = [
    [corners[0], corners[1]],
    [corners[1], corners[3]],
    [corners[3], corners[2]],
    [corners[2], corners[0]],
  ];
  if (edges.some(([edgeStart, edgeEnd]) => segmentsIntersect(start, end, edgeStart, edgeEnd))) return 0;
  return Math.min(
    ...corners.map((corner) => distanceSquaredToSegment(corner, start, end)),
    distanceSquaredPointToRect(start, bounds),
    distanceSquaredPointToRect(end, bounds),
  );
}

function distanceSquaredToSegment(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return (point.x - start.x) ** 2 + (point.y - start.y) ** 2;
  const amount = segmentAmount(point, start, end);
  const nearestX = start.x + amount * dx;
  const nearestY = start.y + amount * dy;
  return (point.x - nearestX) ** 2 + (point.y - nearestY) ** 2;
}

function segmentAmount(point: Point, start: Point, end: Point): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared === 0) return 0;
  return clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
}

function distanceSquaredPointToRect(point: Point, bounds: Bounds): number {
  const dx = Math.max(bounds.x - point.x, 0, point.x - (bounds.x + bounds.width));
  const dy = Math.max(bounds.y - point.y, 0, point.y - (bounds.y + bounds.height));
  return dx * dx + dy * dy;
}

function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const cross = (first: Point, second: Point, third: Point) =>
    (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
  const abC = cross(a, b, c);
  const abD = cross(a, b, d);
  const cdA = cross(c, d, a);
  const cdB = cross(c, d, b);
  if (((abC < 0 && abD > 0) || (abC > 0 && abD < 0))
    && ((cdA < 0 && cdB > 0) || (cdA > 0 && cdB < 0))) return true;
  if (abC === 0 && pointOnSegment(c, a, b)) return true;
  if (abD === 0 && pointOnSegment(d, a, b)) return true;
  if (cdA === 0 && pointOnSegment(a, c, d)) return true;
  return cdB === 0 && pointOnSegment(b, c, d);
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x)
    && point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
}

function rectangleCorners(bounds: Bounds): [Point, Point, Point, Point] {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x, y: bounds.y + bounds.height },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
  ];
}

function pointInRect(point: Point, bounds: Bounds): boolean {
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height;
}

function rectanglesIntersect(first: Bounds, second: Bounds): boolean {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
