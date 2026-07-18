import { RasterQuadTree, type QuadNode } from "./quadtree";
import { WORLD_BOUNDS } from "./types";

const DATABASE_NAME = "quaddraw";
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "active-raster-quadtree";
const MAGIC = 0x51445232; // "QDR2"; deliberately incompatible with path snapshots.
const VERSION = 1;

type StoredSnapshot = {
  blob: Blob;
  compression: "gzip" | "none";
};

export type RestoredDrawing = {
  tree: RasterQuadTree;
  strokeCount: number;
};

/** Persists only quadtree topology and raster values—never input paths. */
export async function saveQuadTree(tree: RasterQuadTree, strokeCount: number): Promise<void> {
  try {
    const writer = new BinaryWriter();
    writer.writeUint32(MAGIC);
    writer.writeUint16(VERSION);
    writer.writeUint32(strokeCount);
    writeNode(writer, tree.snapshot());
    const snapshot = await compress(writer.toBytes());
    const database = await openDatabase();
    await writeSnapshot(database, snapshot);
    database.close();
  } catch (error) {
    console.warn("Could not save raster quadtree", error);
  }
}

export async function loadQuadTree(): Promise<RestoredDrawing | null> {
  try {
    const database = await openDatabase();
    const snapshot = await readSnapshot(database);
    database.close();
    if (!snapshot) return null;

    const reader = new BinaryReader(await decompress(snapshot));
    if (reader.readUint32() !== MAGIC || reader.readUint16() !== VERSION) return null;
    const strokeCount = reader.readUint32();
    const root = readNode(reader);
    return { tree: RasterQuadTree.fromSnapshot(WORLD_BOUNDS, root), strokeCount };
  } catch (error) {
    console.warn("Could not restore raster quadtree", error);
    return null;
  }
}

function writeNode(writer: BinaryWriter, node: QuadNode): void {
  if (node.color !== undefined) {
    writer.writeUint8(0);
    writer.writeUint32(node.color);
    return;
  }
  writer.writeUint8(1);
  node.children.forEach((child) => writeNode(writer, child));
}

function readNode(reader: BinaryReader): QuadNode {
  const kind = reader.readUint8();
  if (kind === 0) return { color: reader.readUint32() };
  if (kind !== 1) throw new Error("Invalid raster quadtree node");
  return {
    children: [readNode(reader), readNode(reader), readNode(reader), readNode(reader)],
  };
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
