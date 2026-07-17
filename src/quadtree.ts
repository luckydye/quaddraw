import type { Bounds } from "./types";

export type QuadTreeSnapshot<T> = {
  bounds: Bounds;
  items: T[];
  children?: QuadTreeSnapshot<T>[];
};

/** A compact spatial index for retrieving strokes visible in the current viewport. */
export class QuadTree<T extends { bounds: Bounds }> {
  private items: T[] = [];
  private children?: QuadTree<T>[];

  constructor(
    public readonly bounds: Bounds,
    private readonly depth = 0,
    private readonly maxItems = 8,
    private readonly maxDepth = 7,
  ) {}

  insert(item: T): boolean {
    if (!rectanglesIntersect(this.bounds, item.bounds)) {
      return false;
    }

    if (this.children) {
      const child = this.childThatContains(item.bounds);
      if (child) {
        return child.insert(item);
      }
    }

    this.items.push(item);

    if (this.items.length > this.maxItems && this.depth < this.maxDepth) {
      this.subdivide();
    }

    return true;
  }

  query(area: Bounds, found: T[] = []): T[] {
    if (!rectanglesIntersect(this.bounds, area)) {
      return found;
    }

    for (const item of this.items) {
      if (rectanglesIntersect(item.bounds, area)) {
        found.push(item);
      }
    }

    for (const child of this.children ?? []) {
      child.query(area, found);
    }

    return found;
  }

  countNodes(): number {
    return 1 + (this.children?.reduce((count, child) => count + child.countNodes(), 0) ?? 0);
  }

  snapshot(): QuadTreeSnapshot<T> {
    return {
      bounds: { ...this.bounds },
      items: [...this.items],
      children: this.children?.map((child) => child.snapshot()),
    };
  }

  allItems(): T[] {
    return [...this.items, ...(this.children?.flatMap((child) => child.allItems()) ?? [])];
  }

  static fromSnapshot<T extends { bounds: Bounds }>(snapshot: QuadTreeSnapshot<T>, depth = 0): QuadTree<T> {
    const tree = new QuadTree<T>(snapshot.bounds, depth);
    tree.items = snapshot.items;
    tree.children = snapshot.children?.map((child) => QuadTree.fromSnapshot(child, depth + 1));
    return tree;
  }

  private subdivide(): void {
    if (this.children) {
      return;
    }

    const { x, y, width, height } = this.bounds;
    const halfWidth = width / 2;
    const halfHeight = height / 2;

    this.children = [
      { x, y, width: halfWidth, height: halfHeight },
      { x: x + halfWidth, y, width: halfWidth, height: halfHeight },
      { x, y: y + halfHeight, width: halfWidth, height: halfHeight },
      { x: x + halfWidth, y: y + halfHeight, width: halfWidth, height: halfHeight },
    ].map((childBounds) => new QuadTree<T>(childBounds, this.depth + 1, this.maxItems, this.maxDepth));

    const parentItems = this.items;
    this.items = [];

    for (const item of parentItems) {
      const child = this.childThatContains(item.bounds);
      if (child) {
        child.insert(item);
      } else {
        this.items.push(item);
      }
    }
  }

  private childThatContains(itemBounds: Bounds): QuadTree<T> | undefined {
    return this.children?.find((child) => contains(child.bounds, itemBounds));
  }
}

export function rectanglesIntersect(first: Bounds, second: Bounds): boolean {
  return (
    first.x < second.x + second.width &&
    first.x + first.width > second.x &&
    first.y < second.y + second.height &&
    first.y + first.height > second.y
  );
}

function contains(container: Bounds, item: Bounds): boolean {
  return (
    item.x >= container.x &&
    item.y >= container.y &&
    item.x + item.width <= container.x + container.width &&
    item.y + item.height <= container.y + container.height
  );
}
