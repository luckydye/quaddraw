import type { Bounds, BrushTexture, Point, QuadDebugRegion, RasterCell } from "./types";

export type QuadLeafNode = { readonly color: number; readonly children?: undefined };
export type QuadBranchNode = {
  readonly color?: undefined;
  readonly children: readonly [QuadNode, QuadNode, QuadNode, QuadNode];
  readonly average: number;
  readonly nodeCount: number;
};
export type QuadNode = QuadLeafNode | QuadBranchNode;

const TRANSPARENT = 0;
const MAX_DEPTH = 15;
const MAX_LOD_CELL_PIXELS = 1.25;
const CHARCOAL_RADIUS_VARIATION_MAX = 1.04;
const CHARCOAL_FEATHER_FACTOR = 0.32;
const CHARCOAL_FEATHER_MINIMUM = 1.25;
const CHARCOAL_FEATHER_OUTSET = 0.45;

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
    density = 1,
    texture: BrushTexture = "solid",
    textureSeed = 0,
    endDensity = density,
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
      clamp(density, 0, 1),
      clamp(endDensity, 0, 1),
      texture,
      textureSeed,
    );
    return nextRoot === this.root ? this : new RasterQuadTree(this.bounds, nextRoot);
  }

  /** Composites one unioned gesture mask so overlapping input segments blend only once. */
  applyMask(mask: RasterQuadTree, color: string, erase = false): RasterQuadTree {
    const nextRoot = applyMaskNode(this.root, mask.root, colorFromHex(color), erase);
    return nextRoot === this.root ? this : new RasterQuadTree(this.bounds, nextRoot);
  }

  cellsIn(area: Bounds): RasterCell[] {
    const cells: RasterCell[] = [];
    collectCells(
      this.root,
      this.bounds.x,
      this.bounds.y,
      this.bounds.width,
      this.bounds.height,
      area,
      cells,
    );
    return cells;
  }

  cellsForRendering(area: Bounds, scale: number): RasterCell[] {
    if (scale >= 1) return this.cellsIn(area);
    const cells: RasterCell[] = [];
    collectRenderCells(
      this.root,
      this.bounds.x,
      this.bounds.y,
      this.bounds.width,
      this.bounds.height,
      area,
      Math.max(scale, 0.0001),
      cells,
    );
    return cells;
  }

  allCells(): RasterCell[] {
    return this.cellsIn(this.bounds);
  }

  debugLeavesIn(area: Bounds, scale = 1): QuadDebugRegion[] {
    const regions: QuadDebugRegion[] = [];
    collectDebugLeaves(this.root, this.bounds, area, Math.max(scale, 0.0001), 0, regions);
    return regions;
  }

  countNodes(): number {
    return isBranchNode(this.root) ? this.root.nodeCount : 1;
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
  startDensity: number,
  endDensity: number,
  texture: BrushTexture,
  textureSeed: number,
): QuadNode {
  const maximumBaseRadius = Math.max(startRadius, endRadius);
  const maximumRadius = texture === "charcoal"
    ? maximumBaseRadius * CHARCOAL_RADIUS_VARIATION_MAX
      + charcoalFeatherWidth(maximumBaseRadius) * CHARCOAL_FEATHER_OUTSET
    : maximumBaseRadius;
  const minimumDistance = Math.sqrt(distanceSquaredSegmentToRect(start, end, bounds));
  if (minimumDistance > maximumRadius + 0.5) {
    return node;
  }

  const maximumDistance = maximumCornerDistance(start, end, bounds);
  const minimumRadius = Math.min(startRadius, endRadius);
  if (
    texture === "solid"
    && startDensity === endDensity
    && maximumDistance <= Math.max(0, minimumRadius - 0.5)
  ) {
    if (erase || startDensity === 1) {
      const replacement = erase ? TRANSPARENT : withAlpha(paintColor, 255);
      return node.color === replacement ? node : uniform(replacement);
    }
    if (!isBranchNode(node)) {
      const replacement = composite(node.color, paintColor, startDensity, false);
      return node.color === replacement ? node : uniform(replacement);
    }
  }

  if (depth >= MAX_DEPTH || (bounds.width <= 1 && bounds.height <= 1)) {
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const distance = Math.sqrt(distanceSquaredToSegment(center, start, end));
    const amount = segmentAmount(center, start, end);
    const isDot = start.x === end.x && start.y === end.y;
    const localRadius = isDot
      ? Math.max(startRadius, endRadius)
      : startRadius + (endRadius - startRadius) * amount;
    const localDensity = isDot
      ? Math.max(startDensity, endDensity)
      : startDensity + (endDensity - startDensity) * amount;
    const texturedRadius = texture === "charcoal"
      ? localRadius * (0.8 + smoothNoise(center, textureSeed ^ 0x51ed270b, 0.24) * 0.24)
      : localRadius;
    const featherWidth = texture === "charcoal" ? charcoalFeatherWidth(localRadius) : 0;
    const coverage = texture === "charcoal"
      ? smoothstep(clamp(
        (texturedRadius
          + featherWidth * CHARCOAL_FEATHER_OUTSET
          + 0.5
          - distance) / featherWidth,
        0,
        1,
      ))
      : clamp(texturedRadius + 0.5 - distance, 0, 1);
    if (coverage === 0) return node;
    const currentColor = node.color ?? representativeColor(node);
    const texturedCoverage = coverage * localDensity * textureCoverage(texture, center, textureSeed);
    const nextColor = composite(currentColor, paintColor, texturedCoverage, erase);
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
      startDensity,
      endDensity,
      texture,
      textureSeed,
    )
  ) as [QuadNode, QuadNode, QuadNode, QuadNode];

  if (children.every((child, index) => child === oldChildren[index])) {
    return node;
  }

  const firstColor = children[0].color;
  if (firstColor !== undefined && children.every((child) => child.color === firstColor)) {
    return uniform(firstColor);
  }

  return createBranchNode(children);
}

function textureCoverage(texture: BrushTexture, point: Point, seed: number): number {
  if (texture === "solid") return 1;

  const broad = smoothNoise(point, seed ^ 0x1b873593, 0.09);
  const grain = smoothNoise(point, seed, 0.52);
  const tooth = spatialNoise(point, seed ^ 0x2c1b3c6d, 1.7);
  return clamp(
    0.56 + broad * 0.34 + (grain - 0.5) * 0.3 + (tooth - 0.5) * 0.12,
    0.32,
    0.98,
  );
}

function charcoalFeatherWidth(radius: number): number {
  return Math.max(CHARCOAL_FEATHER_MINIMUM, radius * CHARCOAL_FEATHER_FACTOR);
}

function smoothNoise(point: Point, seed: number, scale: number): number {
  const scaledX = point.x * scale;
  const scaledY = point.y * scale;
  const x = Math.floor(scaledX);
  const y = Math.floor(scaledY);
  const amountX = smoothstep(scaledX - x);
  const amountY = smoothstep(scaledY - y);
  const top = interpolateNoise(
    latticeNoise(x, y, seed),
    latticeNoise(x + 1, y, seed),
    amountX,
  );
  const bottom = interpolateNoise(
    latticeNoise(x, y + 1, seed),
    latticeNoise(x + 1, y + 1, seed),
    amountX,
  );
  return interpolateNoise(top, bottom, amountY);
}

function spatialNoise(point: Point, seed: number, scale: number): number {
  const x = Math.floor(point.x * scale);
  const y = Math.floor(point.y * scale);
  return latticeNoise(x, y, seed);
}

function latticeNoise(x: number, y: number, seed: number): number {
  let value = (
    Math.imul(x, 0x1f123bb5)
    ^ Math.imul(y, 0x5f356495)
    ^ Math.imul(seed, 0x6c8e9cf5)
  ) >>> 0;
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d) >>> 0;
  value ^= value >>> 12;
  value = Math.imul(value, 0x297a2d39) >>> 0;
  value ^= value >>> 15;
  return (value >>> 0) / 0xffffffff;
}

function smoothstep(amount: number): number {
  return amount * amount * (3 - 2 * amount);
}

function interpolateNoise(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function applyMaskNode(base: QuadNode, mask: QuadNode, paintColor: number, erase: boolean): QuadNode {
  if (!isBranchNode(mask)) {
    const coverage = (mask.color & 0xff) / 255;
    if (coverage === 0) return base;
    if (coverage === 1) {
      const replacement = erase ? TRANSPARENT : paintColor;
      return base.color === replacement ? base : uniform(replacement);
    }
    if (!isBranchNode(base)) {
      const replacement = composite(base.color, paintColor, coverage, erase, false);
      return replacement === base.color ? base : uniform(replacement);
    }
  }

  const baseChildren = base.children ?? [base, base, base, base];
  const maskChildren = mask.children ?? [mask, mask, mask, mask];
  const children = baseChildren.map((child, index) =>
    applyMaskNode(child, maskChildren[index], paintColor, erase)
  ) as [QuadNode, QuadNode, QuadNode, QuadNode];

  if (children.every((child, index) => child === baseChildren[index])) return base;
  const firstColor = children[0].color;
  if (firstColor !== undefined && children.every((child) => child.color === firstColor)) {
    return uniform(firstColor);
  }
  return createBranchNode(children);
}

function collectCells(
  node: QuadNode,
  x: number,
  y: number,
  width: number,
  height: number,
  area: Bounds,
  cells: RasterCell[],
): void {
  if (x >= area.x + area.width || x + width <= area.x || y >= area.y + area.height || y + height <= area.y) return;

  if (node.children === undefined) {
    if ((node.color & 0xff) !== 0) cells.push({ bounds: { x, y, width, height }, color: node.color });
    return;
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  collectCells(node.children[0], x, y, halfWidth, halfHeight, area, cells);
  collectCells(node.children[1], x + halfWidth, y, halfWidth, halfHeight, area, cells);
  collectCells(node.children[2], x, y + halfHeight, halfWidth, halfHeight, area, cells);
  collectCells(node.children[3], x + halfWidth, y + halfHeight, halfWidth, halfHeight, area, cells);
}

function collectRenderCells(
  node: QuadNode,
  x: number,
  y: number,
  width: number,
  height: number,
  area: Bounds,
  scale: number,
  cells: RasterCell[],
): void {
  if (x >= area.x + area.width || x + width <= area.x || y >= area.y + area.height || y + height <= area.y) return;
  if (node.children === undefined) {
    if ((node.color & 0xff) !== 0) cells.push({ bounds: { x, y, width, height }, color: node.color });
    return;
  }
  const branch = node as QuadBranchNode;

  if (Math.max(width, height) * scale <= MAX_LOD_CELL_PIXELS) {
    if ((branch.average & 0xff) !== 0) cells.push({ bounds: { x, y, width, height }, color: branch.average });
    return;
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  collectRenderCells(branch.children[0], x, y, halfWidth, halfHeight, area, scale, cells);
  collectRenderCells(branch.children[1], x + halfWidth, y, halfWidth, halfHeight, area, scale, cells);
  collectRenderCells(branch.children[2], x, y + halfHeight, halfWidth, halfHeight, area, scale, cells);
  collectRenderCells(branch.children[3], x + halfWidth, y + halfHeight, halfWidth, halfHeight, area, scale, cells);
}

function collectDebugLeaves(
  node: QuadNode,
  bounds: Bounds,
  area: Bounds,
  scale: number,
  depth: number,
  regions: QuadDebugRegion[],
): void {
  if (!rectanglesIntersect(bounds, area)) return;
  if (!isBranchNode(node)) {
    regions.push({ bounds, depth, occupied: (node.color & 0xff) !== 0 });
    return;
  }

  if (scale < 1 && Math.max(bounds.width, bounds.height) * scale <= MAX_LOD_CELL_PIXELS) {
    regions.push({ bounds, depth, occupied: (node.average & 0xff) !== 0 });
    return;
  }

  const childBounds = splitBounds(bounds);
  node.children.forEach((child, index) =>
    collectDebugLeaves(child, childBounds[index], area, scale, depth + 1, regions)
  );
}

function representativeColor(node: QuadNode): number {
  return isBranchNode(node) ? node.average : node.color;
}

function isBranchNode(node: QuadNode): node is QuadBranchNode {
  return node.children !== undefined;
}

export function createBranchNode(
  children: readonly [QuadNode, QuadNode, QuadNode, QuadNode],
): QuadNode {
  const colors = children.map(representativeColor);
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
  const average = totals.alpha === 0
    ? TRANSPARENT
    : packColor(
      Math.round(totals.red / totals.alpha),
      Math.round(totals.green / totals.alpha),
      Math.round(totals.blue / totals.alpha),
      Math.round(totals.alpha / 4),
    );
  const nodeCount = 1 + children.reduce(
    (total, child) => total + (isBranchNode(child) ? child.nodeCount : 1),
    0,
  );
  return { children, average, nodeCount };
}

function composite(
  current: number,
  paint: number,
  coverage: number,
  erase: boolean,
  unionSameColor = true,
): number {
  const currentAlpha = (current & 0xff) / 255;
  if (erase) {
    const alpha = Math.round(currentAlpha * (1 - coverage) * 255);
    return alpha === 0 ? TRANSPARENT : withAlpha(current, alpha);
  }

  // Segments within one gesture build a coverage mask, so their overlap is a
  // union. Applying that completed mask to prior strokes uses source-over,
  // including when both strokes share the same color.
  if (
    unionSameColor
    && (current & 0xffffff00) === (paint & 0xffffff00)
    && currentAlpha > 0
  ) {
    const alpha = Math.max(current & 0xff, Math.round(coverage * 255));
    return withAlpha(paint, alpha);
  }

  const outputAlpha = coverage + currentAlpha * (1 - coverage);
  if (outputAlpha <= 0) return TRANSPARENT;
  const currentWeight = currentAlpha * (1 - coverage);
  const red = Math.round((((paint >>> 24) & 0xff) * coverage + ((current >>> 24) & 0xff) * currentWeight) / outputAlpha);
  const green = Math.round((((paint >>> 16) & 0xff) * coverage + ((current >>> 16) & 0xff) * currentWeight) / outputAlpha);
  const blue = Math.round((((paint >>> 8) & 0xff) * coverage + ((current >>> 8) & 0xff) * currentWeight) / outputAlpha);
  const alpha = Math.round(outputAlpha * 255);
  return alpha === 0 ? TRANSPARENT : packColor(red, green, blue, alpha);
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
