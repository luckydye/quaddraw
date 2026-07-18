import { createBranchNode, RasterQuadTree, type QuadNode } from "./quadtree";
import {
  createDrawingDocument,
  type DrawingDocument,
  type DrawingLayer,
} from "./drawing-document";
import { WORLD_BOUNDS } from "./types";

const DATABASE_NAME = "quaddraw";
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "active-raster-quadtree";
const MAGIC = 0x51445232; // "QDR2"; deliberately incompatible with path snapshots.
const VERSION = 3;
const QUADTREE_VERSION = 2;
const MAX_PALETTE_COLORS = 255;
const TAG_TRANSPARENT = 0;
const TAG_BRANCH = 1;
const TAG_PALETTE = 2;
const TAG_RAW_COLOR = 3;
const ENCODE_BATCH_SIZE = 4_096;

type StoredSnapshot = {
  blob: Blob;
  compression: "gzip" | "none";
};

export type RestoredDrawing = {
  document: DrawingDocument;
  snapshotSizes: SnapshotSizes;
  needsUpgrade: boolean;
};

export type SnapshotSizes = {
  compressedBytes: number;
  uncompressedBytes: number;
};

export type DecodedDrawing = {
  document: DrawingDocument;
  version: number;
};

export type DecodedQuadTree = {
  tree: RasterQuadTree;
  strokeCount: number;
  version: number;
};

/** Persists layer metadata and quadtree raster values—never input paths. */
export async function saveDrawing(document: DrawingDocument): Promise<SnapshotSizes | null> {
  try {
    const bytes = await encodeDrawingIncrementally(document);
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

export async function loadDrawing(): Promise<RestoredDrawing | null> {
  try {
    const database = await openDatabase();
    const snapshot = await readSnapshot(database);
    database.close();
    if (!snapshot) return null;

    const bytes = await decompress(snapshot);
    const decoded = decodeDrawing(bytes);
    if (!decoded) return null;
    return {
      document: decoded.document,
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

/** Compatibility wrapper for callers that still save a single raster. */
export async function saveQuadTree(
  tree: RasterQuadTree,
  strokeCount: number,
): Promise<SnapshotSizes | null> {
  return saveDrawing(createDrawingDocument(tree, strokeCount));
}

/** Compatibility wrapper exposing the active raster from a layered snapshot. */
export async function loadQuadTree(): Promise<(
  RestoredDrawing & { tree: RasterQuadTree; strokeCount: number }
) | null> {
  const restored = await loadDrawing();
  if (!restored) return null;
  const layer = restored.document.layers.find(({ id }) => id === restored.document.activeLayerId)!;
  return { ...restored, tree: layer.tree, strokeCount: layer.strokeCount };
}

/** Encodes a compact, transfer-ready full snapshot without compression. */
export function encodeQuadTree(tree: RasterQuadTree, strokeCount: number): Uint8Array {
  const writer = new BinaryWriter();
  writer.writeUint32(MAGIC);
  writer.writeUint16(QUADTREE_VERSION);
  writer.writeUint32(strokeCount);
  writePackedTree(writer, collectNodes(tree.snapshot()));
  return writer.toBytes();
}

/** Encodes a complete ordered layer document. */
export function encodeDrawing(document: DrawingDocument): Uint8Array {
  const writer = new BinaryWriter();
  writeDocumentHeader(writer, document);
  for (const layer of document.layers) {
    writeLayerHeader(writer, layer);
    writePackedTree(writer, collectNodes(layer.tree.snapshot()));
  }
  return writer.toBytes();
}

/** Produces the same snapshot while yielding between batches of tree work. */
export async function encodeQuadTreeIncrementally(
  tree: RasterQuadTree,
  strokeCount: number,
): Promise<Uint8Array> {
  const nodes: QuadNode[] = [];
  const pending = [tree.snapshot()];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push(node.children[index]);
      }
    }
    if (nodes.length % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }

  const writer = new BinaryWriter();
  writer.writeUint32(MAGIC);
  writer.writeUint16(QUADTREE_VERSION);
  writer.writeUint32(strokeCount);
  await writePackedTreeIncrementally(writer, nodes);
  return writer.toBytes();
}

/** Produces the layered snapshot while yielding between tree batches. */
export async function encodeDrawingIncrementally(
  document: DrawingDocument,
): Promise<Uint8Array> {
  const writer = new BinaryWriter();
  writeDocumentHeader(writer, document);
  for (const layer of document.layers) {
    writeLayerHeader(writer, layer);
    const nodes = await collectNodesIncrementally(layer.tree.snapshot());
    await writePackedTreeIncrementally(writer, nodes);
  }
  return writer.toBytes();
}

async function collectNodesIncrementally(root: QuadNode): Promise<QuadNode[]> {
  const nodes: QuadNode[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    nodes.push(node);
    if (node.children) {
      for (let index = node.children.length - 1; index >= 0; index--) {
        pending.push(node.children[index]);
      }
    }
    if (nodes.length % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }
  return nodes;
}

function writeDocumentHeader(writer: BinaryWriter, document: DrawingDocument): void {
  if (document.layers.length === 0) throw new Error("A drawing document needs at least one layer");
  const ids = new Set(document.layers.map(({ id }) => id));
  if (ids.size !== document.layers.length) throw new Error("Drawing layer ids must be unique");
  if (!ids.has(document.activeLayerId)) throw new Error("The active drawing layer does not exist");
  if (ids.has(document.nextLayerId)) throw new Error("The next drawing layer id is already in use");
  writer.writeUint32(MAGIC);
  writer.writeUint16(VERSION);
  writer.writeUint32(document.activeLayerId);
  writer.writeUint32(document.nextLayerId);
  writer.writeUint32(document.layers.length);
}

function writeLayerHeader(writer: BinaryWriter, layer: DrawingLayer): void {
  writer.writeUint32(layer.id);
  writer.writeString(layer.name);
  writer.writeUint8(layer.visible ? 1 : 0);
  writer.writeFloat32(layer.opacity);
  writer.writeUint32(layer.strokeCount);
}

function writePackedTree(writer: BinaryWriter, nodes: readonly QuadNode[]): void {
  const palette = createPalette(nodes);
  const paletteIndices = new Map(palette.map((color, index) => [color, index]));
  writer.writeUint16(palette.length);
  palette.forEach((color) => writer.writeUint32(color));
  writer.writeUint32(nodes.length);

  const tags = new Uint8Array(Math.ceil(nodes.length / 4));
  nodes.forEach((node, index) => {
    tags[index >> 2] |= nodeTag(node, paletteIndices) << ((index & 3) * 2);
  });
  tags.forEach((tag) => writer.writeUint8(tag));
  nodes.forEach((node) => {
    if (node.color !== undefined && (node.color & 0xff) !== 0) {
      const paletteIndex = paletteIndices.get(node.color);
      if (paletteIndex === undefined) writer.writeUint32(node.color);
      else writer.writeUint8(paletteIndex);
    }
  });
}

async function writePackedTreeIncrementally(
  writer: BinaryWriter,
  nodes: readonly QuadNode[],
): Promise<void> {
  const frequencies = new Map<number, number>();
  for (let index = 0; index < nodes.length; index++) {
    const color = nodes[index].color;
    if (color !== undefined && (color & 0xff) !== 0) {
      frequencies.set(color, (frequencies.get(color) ?? 0) + 1);
    }
    if (index > 0 && index % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }
  const entries: [number, number][] = [];
  frequencies.forEach((frequency, color) => entries.push([color, frequency]));
  const palette = entries
    .filter(([, frequency]) => frequency > 1)
    .sort((first, second) => second[1] - first[1])
    .slice(0, MAX_PALETTE_COLORS)
    .map(([color]) => color);
  const paletteIndices = new Map(palette.map((color, index) => [color, index]));
  writer.writeUint16(palette.length);
  palette.forEach((color) => writer.writeUint32(color));
  writer.writeUint32(nodes.length);

  const tags = new Uint8Array(Math.ceil(nodes.length / 4));
  for (let index = 0; index < nodes.length; index++) {
    tags[index >> 2] |= nodeTag(nodes[index], paletteIndices) << ((index & 3) * 2);
    if (index > 0 && index % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }
  for (let index = 0; index < tags.length; index++) {
    writer.writeUint8(tags[index]);
    if (index > 0 && index % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (node.color !== undefined && (node.color & 0xff) !== 0) {
      const paletteIndex = paletteIndices.get(node.color);
      if (paletteIndex === undefined) writer.writeUint32(node.color);
      else writer.writeUint8(paletteIndex);
    }
    if (index > 0 && index % ENCODE_BATCH_SIZE === 0) await yieldToMainThread();
  }
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

/** Reads both compact version 2 snapshots and the original version 1 layout. */
export function decodeQuadTree(bytes: Uint8Array): DecodedQuadTree | null {
  const reader = new BinaryReader(bytes);
  if (reader.readUint32() !== MAGIC) return null;
  const version = reader.readUint16();
  if (version < 1 || version > QUADTREE_VERSION) return null;
  const strokeCount = reader.readUint32();
  const root = version === 1 ? readLegacyNode(reader) : readPackedTree(reader);
  return { tree: RasterQuadTree.fromSnapshot(WORLD_BOUNDS, root), strokeCount, version };
}

/** Reads layered version 3 snapshots and promotes version 1/2 rasters to one layer. */
export function decodeDrawing(bytes: Uint8Array): DecodedDrawing | null {
  const reader = new BinaryReader(bytes);
  if (reader.readUint32() !== MAGIC) return null;
  const version = reader.readUint16();
  if (version < 1 || version > VERSION) return null;
  if (version <= QUADTREE_VERSION) {
    const strokeCount = reader.readUint32();
    const root = version === 1 ? readLegacyNode(reader) : readPackedTree(reader);
    return {
      document: createDrawingDocument(
        RasterQuadTree.fromSnapshot(WORLD_BOUNDS, root),
        strokeCount,
      ),
      version,
    };
  }

  const activeLayerId = reader.readUint32();
  const nextLayerId = reader.readUint32();
  const layerCount = reader.readUint32();
  if (layerCount === 0) throw new Error("Layered drawing snapshot has no layers");
  const ids = new Set<number>();
  const layers: DrawingLayer[] = [];
  for (let index = 0; index < layerCount; index++) {
    const id = reader.readUint32();
    if (ids.has(id)) throw new Error(`Duplicate drawing layer id ${id}`);
    ids.add(id);
    const name = reader.readString();
    const visible = reader.readUint8() !== 0;
    const opacity = reader.readFloat32();
    if (!Number.isFinite(opacity)) throw new Error(`Drawing layer ${id} has invalid opacity`);
    layers.push({
      id,
      name,
      visible,
      opacity: Math.max(0, Math.min(1, opacity)),
      strokeCount: reader.readUint32(),
      tree: RasterQuadTree.fromSnapshot(WORLD_BOUNDS, readPackedTree(reader)),
    });
  }
  if (!ids.has(activeLayerId)) throw new Error("Layered drawing snapshot has an invalid active layer");
  if (ids.has(nextLayerId)) throw new Error("Layered drawing snapshot reuses its next layer id");
  return { document: { layers, activeLayerId, nextLayerId }, version };
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
  writeFloat32(value: number): void { this.writeNumber(4, (view, offset) => view.setFloat32(offset, value, true)); }

  writeString(value: string): void {
    const bytes = new TextEncoder().encode(value);
    if (bytes.byteLength > 0xffff) throw new Error("Drawing layer name is too long");
    this.writeUint16(bytes.byteLength);
    this.ensureCapacity(bytes.byteLength);
    new Uint8Array(this.buffer, this.position, bytes.byteLength).set(bytes);
    this.position += bytes.byteLength;
  }

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
  readFloat32(): number { return this.readNumber(4, (view, offset) => view.getFloat32(offset, true)); }

  readString(): string {
    const length = this.readUint16();
    if (this.position + length > this.bytes.byteLength) {
      throw new Error("Unexpected end of raster quadtree data");
    }
    const value = new TextDecoder().decode(this.bytes.subarray(this.position, this.position + length));
    this.position += length;
    return value;
  }

  private readNumber(length: number, read: (view: DataView, offset: number) => number): number {
    if (this.position + length > this.bytes.byteLength) throw new Error("Unexpected end of raster quadtree data");
    const value = read(this.view, this.position);
    this.position += length;
    return value;
  }
}
