import {
  sampleBrushTexture,
  sampleBrushTip,
  texturedContactCoverage,
} from "./brush-textures";
import type {
  Bounds,
  BrushTexture,
  Point,
  QuadDebugRegion,
  RasterCell,
  RasterSelection,
  RasterSelectionCell,
} from "./types";

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
const FINE_LOD_CELL_PIXELS = 1.25;
const COARSE_LOD_CELL_PIXELS = 2.5;
const FINE_LOD_ZOOM = 0.75;
const COARSE_LOD_ZOOM = 0.35;
const OCCUPIED_BOUNDS_CACHE_MIN_NODES = 128;
const CHARCOAL_RADIUS_VARIATION_MAX = 1.04;
const CHARCOAL_FEATHER_FACTOR = 0.32;
const CHARCOAL_FEATHER_MINIMUM = 1.25;
const CHARCOAL_FEATHER_OUTSET = 0.45;
const occupiedBoundsCache = new WeakMap<QuadNode, Bounds | null>();

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
    textureOffset = 0,
    textureSize = Math.max(startWidth, endWidth),
  ): RasterQuadTree {
    const paintColor = colorFromHex(color);
    if (texture === "bristle") {
      const stamps = createBristleStamps(
        start,
        end,
        startWidth,
        endWidth,
        clamp(density, 0, 1),
        clamp(endDensity, 0, 1),
        textureSeed,
        textureOffset,
        Math.max(textureSize, 1),
      );
      if (stamps.length === 0) return this;
      const nextRoot = paintBristleStamps(
        this.root,
        this.bounds,
        0,
        stamps,
        bristleStampBounds(stamps),
        paintColor,
        erase,
      );
      return nextRoot === this.root ? this : new RasterQuadTree(this.bounds, nextRoot);
    }
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
      textureOffset,
      Math.max(textureSize, 1),
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
    const normalizedScale = Math.max(scale, 0.0001);
    collectRenderCells(
      this.root,
      this.bounds.x,
      this.bounds.y,
      this.bounds.width,
      this.bounds.height,
      area,
      normalizedScale,
      lodCellPixelLimit(normalizedScale),
      cells,
    );
    return cells;
  }

  allCells(): RasterCell[] {
    return this.cellsIn(this.bounds);
  }

  /**
   * Expands a spatial query to every complete 8-connected occupied island it
   * touches. Quadtree leaves are dyadic rectangles, so matching their shared
   * edges avoids flattening the sparse raster into a world-sized pixel grid.
   */
  connectedIslandsTouching(area: Bounds): RasterSelection | null {
    return this.connectedIslandsTouchingAreas([area]);
  }

  /** Selects complete islands seeded by any of the supplied occupied areas. */
  connectedIslandsTouchingAreas(areas: readonly Bounds[]): RasterSelection | null {
    if (areas.length === 0) return null;
    const seeds = new Map<number, IndexedRasterCell>();
    const addSeed: IndexedCellVisitor = (x, y, width, height, color, address) => {
      if (!seeds.has(address)) {
        seeds.set(address, { bounds: { x, y, width, height }, color, address });
      }
    };
    for (const area of areas) {
      this.visitIndexedCells(area, addSeed);
    }
    if (seeds.size === 0) return null;

    const selected = new Map<number, IndexedRasterCell>();
    const neighborOutset = Math.min(this.bounds.width, this.bounds.height)
      / 2 ** MAX_DEPTH / 4;
    let islandCount = 0;
    let pending: IndexedRasterCell[] = [];
    const addNeighbor: IndexedCellVisitor = (x, y, width, height, color, address) => {
      if (selected.has(address)) return;
      const neighbor = { bounds: { x, y, width, height }, color, address };
      selected.set(address, neighbor);
      pending.push(neighbor);
    };

    for (const seed of seeds.values()) {
      if (selected.has(seed.address)) continue;
      islandCount += 1;
      selected.set(seed.address, seed);
      pending = [seed];

      for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex++) {
        const cell = pending[pendingIndex];
        this.visitIndexedCells(expandBounds(cell.bounds, neighborOutset), addNeighbor);
      }
    }

    const selectedCells = [...selected.values()];
    return {
      cells: selectedCells,
      bounds: enclosingBounds(selectedCells),
      islandCount,
    };
  }

  private visitIndexedCells(area: Bounds, visitor: IndexedCellVisitor): void {
    collectIndexedCells(
      this.root,
      this.bounds.x,
      this.bounds.y,
      this.bounds.width,
      this.bounds.height,
      area,
      1,
      visitor,
    );
  }

  /** Snaps a movement vector to the persistent raster's finest grid. */
  snapTranslation(x: number, y: number): Point {
    const columns = 2 ** MAX_DEPTH;
    const stepX = this.bounds.width / columns;
    const stepY = this.bounds.height / columns;
    return {
      x: Math.round(x / stepX) * stepX,
      y: Math.round(y / stepY) * stepY,
    };
  }

  /** Cuts selected leaves and composites their colors at a translated position. */
  moveCells(cells: readonly RasterSelectionCell[], x: number, y: number): RasterQuadTree {
    return this.moveCellsWithSelection(cells, x, y).tree;
  }

  /** Moves many leaves as one translated tree and returns their new leaf addresses. */
  moveSelection(selection: RasterSelection, x: number, y: number): {
    tree: RasterQuadTree;
    selection: RasterSelection;
  } {
    const moved = this.moveCellsWithSelection(selection.cells, x, y);
    return {
      tree: moved.tree,
      selection: {
        cells: moved.cells,
        bounds: enclosingBounds(moved.cells),
        islandCount: selection.islandCount,
      },
    };
  }

  private moveCellsWithSelection(
    cells: readonly RasterSelectionCell[],
    x: number,
    y: number,
  ): { tree: RasterQuadTree; cells: RasterSelectionCell[] } {
    if (cells.length === 0 || (x === 0 && y === 0)) {
      return { tree: this, cells: [...cells] };
    }
    const selectedAddresses = new Set<number>();
    const affectedBranches = new Set<number>();
    for (const cell of cells) {
      selectedAddresses.add(cell.address);
      for (let address = Math.floor(cell.address / 4); address >= 1; address = Math.floor(address / 4)) {
        affectedBranches.add(address);
      }
    }
    const remainingRoot = removeSelectedCells(
      this.root,
      this.bounds,
      selectedAddresses,
      affectedBranches,
      1,
    );
    const translatedCells = cells.map((cell) => ({
      bounds: {
        x: cell.bounds.x + x,
        y: cell.bounds.y + y,
        width: cell.bounds.width,
        height: cell.bounds.height,
      },
      color: cell.color,
    }));
    const movedRoot = buildCellTree(translatedCells, this.bounds, 0);
    const nextRoot = compositeSourceTree(remainingRoot, movedRoot);
    const movedCells: RasterSelectionCell[] = [];
    collectCellsOverlappingMask(nextRoot, movedRoot, this.bounds, 1, movedCells);
    return {
      tree: nextRoot === this.root ? this : new RasterQuadTree(this.bounds, nextRoot),
      cells: movedCells,
    };
  }

  debugLeavesIn(area: Bounds, scale = 1): QuadDebugRegion[] {
    const regions: QuadDebugRegion[] = [];
    const normalizedScale = Math.max(scale, 0.0001);
    collectDebugLeaves(
      this.root,
      this.bounds,
      area,
      normalizedScale,
      lodCellPixelLimit(normalizedScale),
      0,
      regions,
    );
    return regions;
  }

  countNodes(): number {
    return isBranchNode(this.root) ? this.root.nodeCount : 1;
  }

  /** Max-depth raster pixels spanned by the bounds of all non-transparent leaves. */
  occupiedResolution(): { width: number; height: number } {
    const occupied = occupiedBounds(this.root, this.bounds);
    if (!occupied) return { width: 0, height: 0 };
    const maximumResolution = 2 ** MAX_DEPTH;
    return {
      width: Math.round(occupied.width / this.bounds.width * maximumResolution),
      height: Math.round(occupied.height / this.bounds.height * maximumResolution),
    };
  }

  /** World-space bounds of all non-transparent leaves. */
  occupiedBounds(): Bounds | null {
    return occupiedBounds(this.root, this.bounds);
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
  textureOffset: number,
  textureSize: number,
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
    const maskCoverage = texture === "charcoal"
      ? charcoalTextureCoverage(center, textureSeed)
      : bristleTextureCoverage(
        texture,
        center,
        start,
        end,
        localRadius,
        textureOffset,
        textureSize,
        textureSeed,
      );
    const pigmentCoverage = texture === "solid"
      ? localDensity * maskCoverage
      : texturedContactCoverage(
        maskCoverage,
        localDensity,
      );
    const texturedCoverage = coverage * pigmentCoverage;
    if (texturedCoverage === 0) return node;
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
      textureOffset,
      textureSize,
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

type BristleStamp = {
  center: Point;
  direction: Point;
  gestureDistance: number;
  width: number;
  density: number;
  seed: number;
  textureSeed: number;
};

const BRISTLE_STAMP_SPACING = 0.12;
// A brush tip occupies a square footprint; the swatch's own alpha remains
// horizontally irregular inside it. Stretching the source canvas to 2:1 makes
// overlapping stamps flare outward at every turn.
const BRISTLE_STAMP_ASPECT = 1;

function createBristleStamps(
  start: Point,
  end: Point,
  startWidth: number,
  endWidth: number,
  startDensity: number,
  endDensity: number,
  seed: number,
  textureOffset: number,
  textureSize: number,
): BristleStamp[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    const angle = (seed >>> 0) / 0xffffffff * Math.PI * 2;
    return [{
      center: start,
      direction: { x: Math.cos(angle), y: Math.sin(angle) },
      gestureDistance: textureOffset,
      width: Math.max(startWidth, endWidth, 1),
      density: Math.max(startDensity, endDensity),
      seed,
      textureSeed: seed,
    }];
  }

  const spacing = Math.max(textureSize * BRISTLE_STAMP_SPACING, 0.75);
  const phase = ((textureOffset % spacing) + spacing) % spacing;
  let distance = phase < 1e-6 || spacing - phase < 1e-6 ? 0 : spacing - phase;
  const direction = { x: dx / length, y: dy / length };
  const stamps: BristleStamp[] = [];
  while (distance <= length + 1e-6) {
    const amount = clamp(distance / length, 0, 1);
    const stampIndex = Math.round((textureOffset + distance) / spacing);
    stamps.push({
      center: { x: start.x + dx * amount, y: start.y + dy * amount },
      direction,
      gestureDistance: textureOffset + distance,
      width: Math.max(startWidth + (endWidth - startWidth) * amount, 1),
      density: startDensity + (endDensity - startDensity) * amount,
      seed: seed ^ Math.imul(stampIndex, 0x9e3779b1),
      textureSeed: seed,
    });
    distance += spacing;
  }
  return stamps;
}

function bristleStampBounds(stamps: readonly BristleStamp[]): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const stamp of stamps) {
    const halfAlong = stamp.width * BRISTLE_STAMP_ASPECT / 2;
    const halfAcross = stamp.width / 2;
    const extentX = Math.abs(stamp.direction.x) * halfAlong
      + Math.abs(stamp.direction.y) * halfAcross + 1;
    const extentY = Math.abs(stamp.direction.y) * halfAlong
      + Math.abs(stamp.direction.x) * halfAcross + 1;
    left = Math.min(left, stamp.center.x - extentX);
    top = Math.min(top, stamp.center.y - extentY);
    right = Math.max(right, stamp.center.x + extentX);
    bottom = Math.max(bottom, stamp.center.y + extentY);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function paintBristleStamps(
  node: QuadNode,
  bounds: Bounds,
  depth: number,
  stamps: readonly BristleStamp[],
  paintedBounds: Bounds,
  paintColor: number,
  erase: boolean,
): QuadNode {
  if (!rectanglesIntersect(bounds, paintedBounds)) return node;

  if (depth >= MAX_DEPTH || (bounds.width <= 1 && bounds.height <= 1)) {
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    let coverage = 0;
    for (const stamp of stamps) {
      const relativeX = point.x - stamp.center.x;
      const relativeY = point.y - stamp.center.y;
      const along = relativeX * stamp.direction.x + relativeY * stamp.direction.y;
      const across = relativeY * stamp.direction.x - relativeX * stamp.direction.y;
      const loadVariation = bristleLoadVariation(
        stamp.gestureDistance + along,
        across,
        stamp.width,
        stamp.textureSeed,
      );
      const stampCoverage = texturedContactCoverage(sampleBrushTip(
        "bristle",
        0.5 + along / (stamp.width * BRISTLE_STAMP_ASPECT),
        0.5 + across / stamp.width,
        stamp.seed,
      ), stamp.density, loadVariation);
      coverage = Math.max(coverage, stampCoverage);
      if (coverage >= 1) break;
    }
    if (coverage === 0) return node;
    const currentColor = node.color ?? representativeColor(node);
    const nextColor = composite(currentColor, paintColor, coverage, erase);
    return nextColor === currentColor ? node : uniform(nextColor);
  }

  const childBounds = splitBounds(bounds);
  const oldChildren = node.children ?? [node, node, node, node];
  const children = oldChildren.map((child, index) => paintBristleStamps(
    child,
    childBounds[index],
    depth + 1,
    stamps,
    paintedBounds,
    paintColor,
    erase,
  )) as [QuadNode, QuadNode, QuadNode, QuadNode];
  if (children.every((child, index) => child === oldChildren[index])) return node;
  const firstColor = children[0].color;
  if (firstColor !== undefined && children.every((child) => child.color === firstColor)) {
    return uniform(firstColor);
  }
  return createBranchNode(children);
}

/** Continuous, direction-aligned pigment loading; never punches out holes. */
function bristleLoadVariation(
  along: number,
  across: number,
  brushWidth: number,
  seed: number,
): number {
  const alongSize = Math.max(10, brushWidth * 0.7);
  const acrossSize = Math.max(1.75, brushWidth * 0.08);
  const strands = smoothNoise(
    { x: along / alongSize, y: across / acrossSize },
    seed ^ 0x85ebca6b,
    1,
  );
  const loading = smoothNoise(
    { x: along / (alongSize * 0.4), y: across / (acrossSize * 2.4) },
    seed ^ 0xc2b2ae35,
    1,
  );
  return clamp((strands * 0.78 + loading * 0.22 - 0.5) * 1.7 + 0.5, 0, 1);
}

function bristleTextureCoverage(
  texture: BrushTexture,
  point: Point,
  start: Point,
  end: Point,
  radius: number,
  textureOffset: number,
  textureSize: number,
  seed: number,
): number {
  if (texture === "solid") return 1;

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  let alongDistance: number;
  let acrossDistance: number;
  if (length > 0) {
    const relativeX = point.x - start.x;
    const relativeY = point.y - start.y;
    alongDistance = (relativeX * dx + relativeY * dy) / length;
    acrossDistance = (relativeY * dx - relativeX * dy) / length;
  } else {
    const angle = (seed >>> 0) / 0xffffffff * Math.PI * 2;
    const relativeX = point.x - start.x;
    const relativeY = point.y - start.y;
    alongDistance = relativeX * Math.cos(angle) + relativeY * Math.sin(angle);
    acrossDistance = relativeY * Math.cos(angle) - relativeX * Math.sin(angle);
  }

  // The source texture is 2:1, so one repeat spans two brush diameters. Its
  // horizontal coordinate advances continuously across flattened curve pieces.
  const period = Math.max(textureSize * 2, 2);
  return sampleBrushTexture(
    texture,
    (textureOffset + alongDistance) / period,
    0.5 + acrossDistance / (Math.max(radius, 0.5) * 2),
    seed,
  );
}

function charcoalTextureCoverage(point: Point, seed: number): number {
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

type IndexedRasterCell = RasterSelectionCell;
type IndexedCellVisitor = (
  x: number,
  y: number,
  width: number,
  height: number,
  color: number,
  address: number,
) => void;

function collectIndexedCells(
  node: QuadNode,
  x: number,
  y: number,
  width: number,
  height: number,
  area: Bounds,
  address: number,
  visitor: IndexedCellVisitor,
): void {
  if (x >= area.x + area.width || x + width <= area.x || y >= area.y + area.height || y + height <= area.y) return;
  if (!isBranchNode(node)) {
    if ((node.color & 0xff) !== 0) visitor(x, y, width, height, node.color, address);
    return;
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  collectIndexedCells(node.children[0], x, y, halfWidth, halfHeight, area, address * 4, visitor);
  collectIndexedCells(node.children[1], x + halfWidth, y, halfWidth, halfHeight, area, address * 4 + 1, visitor);
  collectIndexedCells(node.children[2], x, y + halfHeight, halfWidth, halfHeight, area, address * 4 + 2, visitor);
  collectIndexedCells(node.children[3], x + halfWidth, y + halfHeight, halfWidth, halfHeight, area, address * 4 + 3, visitor);
}

function occupiedBounds(node: QuadNode, bounds: Bounds): Bounds | null {
  const occupied = normalizedOccupiedBounds(node);
  return occupied && {
    x: bounds.x + occupied.x * bounds.width,
    y: bounds.y + occupied.y * bounds.height,
    width: occupied.width * bounds.width,
    height: occupied.height * bounds.height,
  };
}

/**
 * Caches only substantial immutable subtrees. New brush versions share most
 * of these nodes, so exact occupied bounds become proportional to the edit
 * instead of requiring a whole-document traversal after every stroke.
 */
function normalizedOccupiedBounds(node: QuadNode): Bounds | null {
  if (!isBranchNode(node)) {
    return (node.color & 0xff) === 0 ? null : { x: 0, y: 0, width: 1, height: 1 };
  }
  const cacheResult = node.nodeCount >= OCCUPIED_BOUNDS_CACHE_MIN_NODES;
  if (cacheResult && occupiedBoundsCache.has(node)) return occupiedBoundsCache.get(node)!;

  let occupied: Bounds | null = null;
  node.children.forEach((child, index) => {
    const childOccupied = normalizedOccupiedBounds(child);
    if (!childOccupied) return;
    const mapped = {
      x: (index % 2) * 0.5 + childOccupied.x * 0.5,
      y: (index >= 2 ? 0.5 : 0) + childOccupied.y * 0.5,
      width: childOccupied.width * 0.5,
      height: childOccupied.height * 0.5,
    };
    if (!occupied) {
      occupied = mapped;
      return;
    }
    const right = Math.max(occupied.x + occupied.width, mapped.x + mapped.width);
    const bottom = Math.max(occupied.y + occupied.height, mapped.y + mapped.height);
    const x = Math.min(occupied.x, mapped.x);
    const y = Math.min(occupied.y, mapped.y);
    occupied = { x, y, width: right - x, height: bottom - y };
  });
  if (cacheResult) occupiedBoundsCache.set(node, occupied);
  return occupied;
}

function collectRenderCells(
  node: QuadNode,
  x: number,
  y: number,
  width: number,
  height: number,
  area: Bounds,
  scale: number,
  cellPixelLimit: number,
  cells: RasterCell[],
): void {
  if (x >= area.x + area.width || x + width <= area.x || y >= area.y + area.height || y + height <= area.y) return;
  if (node.children === undefined) {
    if ((node.color & 0xff) !== 0) cells.push({ bounds: { x, y, width, height }, color: node.color });
    return;
  }
  const branch = node as QuadBranchNode;

  if (Math.max(width, height) * scale <= cellPixelLimit) {
    if ((branch.average & 0xff) !== 0) cells.push({ bounds: { x, y, width, height }, color: branch.average });
    return;
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  collectRenderCells(
    branch.children[0], x, y, halfWidth, halfHeight, area, scale, cellPixelLimit, cells,
  );
  collectRenderCells(
    branch.children[1], x + halfWidth, y, halfWidth, halfHeight, area, scale, cellPixelLimit, cells,
  );
  collectRenderCells(
    branch.children[2], x, y + halfHeight, halfWidth, halfHeight, area, scale, cellPixelLimit, cells,
  );
  collectRenderCells(
    branch.children[3], x + halfWidth, y + halfHeight, halfWidth, halfHeight, area, scale, cellPixelLimit, cells,
  );
}

function collectDebugLeaves(
  node: QuadNode,
  bounds: Bounds,
  area: Bounds,
  scale: number,
  cellPixelLimit: number,
  depth: number,
  regions: QuadDebugRegion[],
): void {
  if (!rectanglesIntersect(bounds, area)) return;
  if (!isBranchNode(node)) {
    regions.push({ bounds, depth, occupied: (node.color & 0xff) !== 0 });
    return;
  }

  if (scale < 1 && Math.max(bounds.width, bounds.height) * scale <= cellPixelLimit) {
    regions.push({ bounds, depth, occupied: (node.average & 0xff) !== 0 });
    return;
  }

  const childBounds = splitBounds(bounds);
  node.children.forEach((child, index) =>
    collectDebugLeaves(child, childBounds[index], area, scale, cellPixelLimit, depth + 1, regions)
  );
}

function lodCellPixelLimit(scale: number): number {
  const coarseAmount = clamp(
    (FINE_LOD_ZOOM - scale) / (FINE_LOD_ZOOM - COARSE_LOD_ZOOM),
    0,
    1,
  );
  return FINE_LOD_CELL_PIXELS
    + (COARSE_LOD_CELL_PIXELS - FINE_LOD_CELL_PIXELS) * coarseAmount;
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

function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    width: bounds.width + amount * 2,
    height: bounds.height + amount * 2,
  };
}

function removeSelectedCells(
  node: QuadNode,
  bounds: Bounds,
  selectedAddresses: ReadonlySet<number>,
  affectedBranches: ReadonlySet<number>,
  address: number,
): QuadNode {
  if (!selectedAddresses.has(address) && !affectedBranches.has(address)) return node;
  if (!isBranchNode(node)) {
    return selectedAddresses.has(address) ? uniform(TRANSPARENT) : node;
  }
  const childBounds = splitBounds(bounds);
  const children = node.children.map((child, index) =>
    removeSelectedCells(
      child,
      childBounds[index],
      selectedAddresses,
      affectedBranches,
      address * 4 + index,
    )
  ) as [QuadNode, QuadNode, QuadNode, QuadNode];
  if (children.every((child, index) => child === node.children[index])) return node;
  return collapsedNode(children);
}

function buildCellTree(
  cells: readonly RasterCell[],
  bounds: Bounds,
  depth: number,
): QuadNode {
  if (cells.length === 0) return uniform(TRANSPARENT);
  const coveringCell = cells.find((cell) => rectangleContains(cell.bounds, bounds));
  if (coveringCell) return uniform(coveringCell.color);
  if (depth >= MAX_DEPTH || (bounds.width <= 1 && bounds.height <= 1)) {
    const cell = cells.find((candidate) => rectanglesIntersect(candidate.bounds, bounds));
    return uniform(cell?.color ?? TRANSPARENT);
  }

  const childBounds = splitBounds(bounds);
  const cellsByChild: RasterCell[][] = [[], [], [], []];
  for (const cell of cells) {
    for (let index = 0; index < childBounds.length; index++) {
      if (rectanglesIntersect(cell.bounds, childBounds[index])) cellsByChild[index].push(cell);
    }
  }
  return collapsedNode(childBounds.map((child, index) =>
    buildCellTree(cellsByChild[index], child, depth + 1)
  ) as [QuadNode, QuadNode, QuadNode, QuadNode]);
}

function compositeSourceTree(base: QuadNode, source: QuadNode): QuadNode {
  if (!isBranchNode(source)) {
    const sourceAlpha = source.color & 0xff;
    if (sourceAlpha === 0) return base;
    if (sourceAlpha === 255) return source;
    if (!isBranchNode(base)) {
      return uniform(composite(base.color, source.color, sourceAlpha / 255, false, false));
    }
  }
  if (!isBranchNode(base) && (base.color & 0xff) === 0) return source;

  const baseChildren = base.children ?? [base, base, base, base];
  const sourceChildren = source.children ?? [source, source, source, source];
  const children = baseChildren.map((child, index) =>
    compositeSourceTree(child, sourceChildren[index])
  ) as [QuadNode, QuadNode, QuadNode, QuadNode];
  if (children.every((child, index) => child === baseChildren[index])) return base;
  // Keep a source branch even when equal colors could collapse it. The mask
  // boundary is also the addressable boundary of the moved selection.
  return isBranchNode(source) ? createBranchNode(children) : collapsedNode(children);
}

function collectCellsOverlappingMask(
  node: QuadNode,
  mask: QuadNode,
  bounds: Bounds,
  address: number,
  cells: RasterSelectionCell[],
): void {
  if (!isBranchNode(mask) && (mask.color & 0xff) === 0) return;
  if (!isBranchNode(node)) {
    if ((node.color & 0xff) !== 0) cells.push({ bounds, color: node.color, address });
    return;
  }

  const childBounds = splitBounds(bounds);
  const maskChildren = mask.children ?? [mask, mask, mask, mask];
  node.children.forEach((child, index) =>
    collectCellsOverlappingMask(
      child,
      maskChildren[index],
      childBounds[index],
      address * 4 + index,
      cells,
    )
  );
}

function rectangleContains(container: Bounds, contained: Bounds): boolean {
  return container.x <= contained.x
    && container.y <= contained.y
    && container.x + container.width >= contained.x + contained.width
    && container.y + container.height >= contained.y + contained.height;
}

function collapsedNode(children: readonly [QuadNode, QuadNode, QuadNode, QuadNode]): QuadNode {
  const firstColor = children[0].color;
  if (firstColor !== undefined && children.every((child) => child.color === firstColor)) {
    return uniform(firstColor);
  }
  return createBranchNode(children);
}

function enclosingBounds(cells: readonly RasterCell[]): Bounds {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const cell of cells) {
    left = Math.min(left, cell.bounds.x);
    top = Math.min(top, cell.bounds.y);
    right = Math.max(right, cell.bounds.x + cell.bounds.width);
    bottom = Math.max(bottom, cell.bounds.y + cell.bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
