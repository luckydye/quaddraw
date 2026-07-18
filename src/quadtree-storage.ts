import { createBranchNode, RasterQuadTree, type QuadNode } from "./quadtree";
import { WORLD_BOUNDS } from "./types";

const DATABASE_NAME = "quaddraw";
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "active-raster-quadtree";
const MAGIC = 0x51445232; // "QDR2"; deliberately incompatible with path snapshots.
const VERSION = 2;
const MAX_PALETTE_COLORS = 255;
const TAG_TRANSPARENT = 0;
const TAG_BRANCH = 1;
const TAG_PALETTE = 2;
const TAG_RAW_COLOR = 3;

type StoredSnapshot = {
  blob: Blob;
  compression: "gzip" | "none";
};

export type RestoredDrawing = {
  tree: RasterQuadTree;
  strokeCount: number;
  snapshotSizes: SnapshotSizes;
  needsUpgrade: boolean;
};

export type SnapshotSizes = {
  compressedBytes: number;
  uncompressedBytes: number;
};

export type DecodedDrawing = {
  tree: RasterQuadTree;
  strokeCount: number;
  version: number;
};

/** Persists only quadtree topology and raster values—never input paths. */
export async function saveQuadTree(tree: RasterQuadTree, strokeCount: number): Promise<SnapshotSizes | null> {
  try {
    const bytes = encodeQuadTree(tree, strokeCount);
    const snapshot = await compress(bytes);
    const database = await openDatabase();
    await writeSnapshot(database, snapshot);
    database.close();
    return { compressedBytes: snapshot.blob.size, uncompressedBytes: bytes.byteLength };
  } catch (error) {
    console.warn("Could not save raster quadtree", error);
    return null;
  }
}

export async function loadQuadTree(): Promise<RestoredDrawing | null> {
  try {
    const database = await openDatabase();
    const snapshot = await readSnapshot(database);
    database.close();
    if (!snapshot) return null;

    const bytes = await decompress(snapshot);
    const decoded = decodeQuadTree(bytes);
    if (!decoded) return null;
    return {
      tree: decoded.tree,
      strokeCount: decoded.strokeCount,
      snapshotSizes: {
        compressedBytes: snapshot.blob.size,
        uncompressedBytes: bytes.byteLength,
      },
      needsUpgrade: decoded.version < VERSION,
    };
  } catch (error) {
    console.warn("Could not restore raster quadtree", error);
    return null;
  }
}

/** Encodes a compact, transfer-ready full snapshot without compression. */
export function encodeQuadTree(tree: RasterQuadTree, strokeCount: number): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeUint32(MAGIC);
  writer.writeUint16(VERSION);
  writer.writeUint32(strokeCount);

  const nodes = collectNodes(tree.snapshot());
  const palette = createPalette(nodes);
  const paletteIndices = new Map(palette.map((color, index) => [color, index]));
  writer.writeUint16(palette.length);
  palette.forEach((color) => writer.writeUint32(color));
  writer.writeUint32(nodes.length);

  const tags = new Uint8Array(Math.ceil(nodes.length / 4));
  nodes.forEach((node, index) => {
    const tag = nodeTag(node, paletteIndices);
    tags[index >> 2] |= tag << ((index & 3) * 2);
  });
  tags.forEach((tagByte) => writer.writeUint8(tagByte));

  nodes.forEach((node) => {
    if (node.color === undefined || (node.color & 0xff) === 0) return;
    const paletteIndex = paletteIndices.get(node.color);
    if (paletteIndex === undefined) writer.writeUint32(node.color);
    else writer.writeUint8(paletteIndex);
  });
  return writer.toBytes();
}

/** Reads both compact version 2 snapshots and the original version 1 layout. */
export function decodeQuadTree(bytes: Uint8Array): DecodedDrawing | null {
  const reader = new BinaryReader(bytes);
  if (reader.readUint32() !== MAGIC) return null;
  const version = reader.readUint16();
  if (version < 1 || version > VERSION) return null;
  const strokeCount = reader.readUint32();
  const root = version === 1 ? readLegacyNode(reader) : readPackedTree(reader);
  return { tree: RasterQuadTree.fromSnapshot(WORLD_BOUNDS, root), strokeCount, version };
}

function collectNodes(root: QuadNode): QuadNode[] {
  const nodes: QuadNode[] = [];
  const visit = (node: QuadNode): void => {
    nodes.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return nodes;
}

function createPalette(nodes: readonly QuadNode[]): number[] {
  const frequencies = new Map<number, number>();
  nodes.forEach((node) => {
    if (node.color !== undefined && (node.color & 0xff) !== 0) {
      frequencies.set(node.color, (frequencies.get(node.color) ?? 0) + 1);
    }
  });
  const entries: [number, number][] = [];
  frequencies.forEach((frequency, color) => entries.push([color, frequency]));
  return entries
    .filter(([, frequency]) => frequency > 1)
    .sort((first, second) => second[1] - first[1])
    .slice(0, MAX_PALETTE_COLORS)
    .map(([color]) => color);
}

function nodeTag(node: QuadNode, paletteIndices: ReadonlyMap<number, number>): number {
  if (node.color === undefined) return TAG_BRANCH;
  if ((node.color & 0xff) === 0) return TAG_TRANSPARENT;
  return paletteIndices.has(node.color) ? TAG_PALETTE : TAG_RAW_COLOR;
}

function readPackedTree(reader: BinaryReader): QuadNode {
  const paletteLength = reader.readUint16();
  const palette = Array.from({ length: paletteLength }, () => reader.readUint32());
  const nodeCount = reader.readUint32();
  if (nodeCount === 0) throw new Error("Raster quadtree snapshot has no root node");
  const tags = Array.from({ length: Math.ceil(nodeCount / 4) }, () => reader.readUint8());
  let nodeIndex = 0;

  const readNode = (): QuadNode => {
    if (nodeIndex >= nodeCount) throw new Error("Raster quadtree topology exceeds its node count");
    const tag = (tags[nodeIndex >> 2] >> ((nodeIndex & 3) * 2)) & 0b11;
    nodeIndex += 1;
    if (tag === TAG_TRANSPARENT) return { color: 0 };
    if (tag === TAG_PALETTE) {
      const paletteIndex = reader.readUint8();
      const color = palette[paletteIndex];
      if (color === undefined) throw new Error("Invalid raster quadtree palette index");
      return { color };
    }
    if (tag === TAG_RAW_COLOR) return { color: reader.readUint32() };
    return createBranchNode([readNode(), readNode(), readNode(), readNode()]);
  };

  const root = readNode();
  if (nodeIndex !== nodeCount) throw new Error("Raster quadtree topology did not consume every node");
  return root;
}

function readLegacyNode(reader: BinaryReader): QuadNode {
  const kind = reader.readUint8();
  if (kind === 0) return { color: reader.readUint32() };
  if (kind !== 1) throw new Error("Invalid legacy raster quadtree node");
  return createBranchNode([
    readLegacyNode(reader),
    readLegacyNode(reader),
    readLegacyNode(reader),
    readLegacyNode(reader),
  ]);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function writeSnapshot(database: IDBDatabase, snapshot: StoredSnapshot): Promise<void> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(snapshot, SNAPSHOT_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

function readSnapshot(database: IDBDatabase): Promise<StoredSnapshot | undefined> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
    request.onsuccess = () => resolve(request.result as StoredSnapshot | undefined);
    request.onerror = () => reject(request.error);
  });
}

async function compress(bytes: Uint8Array): Promise<StoredSnapshot> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  if (!("CompressionStream" in window)) {
    return { blob: new Blob([buffer], { type: "application/octet-stream" }), compression: "none" };
  }
  const stream = new Blob([buffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return { blob: await new Response(stream).blob(), compression: "gzip" };
}

async function decompress(snapshot: StoredSnapshot): Promise<Uint8Array> {
  const stream = snapshot.compression === "gzip"
    ? snapshot.blob.stream().pipeThrough(new DecompressionStream("gzip"))
    : snapshot.blob.stream();
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class BinaryWriter {
  private buffer = new ArrayBuffer(1_024);
  private view = new DataView(this.buffer);
  private position = 0;

  writeUint8(value: number): void { this.writeNumber(1, (view, offset) => view.setUint8(offset, value)); }
  writeUint16(value: number): void { this.writeNumber(2, (view, offset) => view.setUint16(offset, value, true)); }
  writeUint32(value: number): void { this.writeNumber(4, (view, offset) => view.setUint32(offset, value, true)); }

  toBytes(): Uint8Array { return new Uint8Array(this.buffer, 0, this.position); }

  private writeNumber(length: number, write: (view: DataView, offset: number) => void): void {
    this.ensureCapacity(length);
    write(this.view, this.position);
    this.position += length;
  }

  private ensureCapacity(required: number): void {
    if (this.position + required <= this.buffer.byteLength) return;
    const expanded = new ArrayBuffer(Math.max(this.buffer.byteLength * 2, this.position + required));
    new Uint8Array(expanded).set(new Uint8Array(this.buffer));
    this.buffer = expanded;
    this.view = new DataView(expanded);
  }
}

class BinaryReader {
  private position = 0;
  private readonly view: DataView;

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readUint8(): number { return this.readNumber(1, (view, offset) => view.getUint8(offset)); }
  readUint16(): number { return this.readNumber(2, (view, offset) => view.getUint16(offset, true)); }
  readUint32(): number { return this.readNumber(4, (view, offset) => view.getUint32(offset, true)); }

  private readNumber(length: number, read: (view: DataView, offset: number) => number): number {
    if (this.position + length > this.bytes.byteLength) throw new Error("Unexpected end of raster quadtree data");
    const value = read(this.view, this.position);
    this.position += length;
    return value;
  }
}
