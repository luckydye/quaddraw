import { QuadTree, type QuadTreeSnapshot } from "./quadtree";
import { boundsFromPoints, type CubicSegment, type Point, type Stroke } from "./types";

const DATABASE_NAME = "quaddraw";
const STORE_NAME = "snapshots";
const SNAPSHOT_KEY = "active-quadtree";
const MAGIC = 0x51445257; // "QDRW"
const VERSION = 5;

type StoredSnapshot = {
  blob: Blob;
  compression: "gzip" | "none";
};

/** Stores the full quadtree topology and paths as a compressed binary Blob. */
export async function saveQuadTree(tree: QuadTree<Stroke>): Promise<void> {
  try {
    const writer = new BinaryWriter();
    writer.writeUint32(MAGIC);
    writer.writeUint16(VERSION);
    writeNode(writer, tree.snapshot());
    const snapshot = await compress(writer.toBytes());
    const database = await openDatabase();
    await writeSnapshot(database, snapshot);
    database.close();
  } catch (error) {
    console.warn("Could not save quadtree", error);
  }
}

export async function loadQuadTree(): Promise<QuadTree<Stroke> | null> {
  try {
    const database = await openDatabase();
    const snapshot = await readSnapshot(database);
    database.close();
    if (!snapshot) {
      return null;
    }

    return decodeQuadTree(await decompress(snapshot));
  } catch (error) {
    console.warn("Could not restore quadtree", error);
    return null;
  }
}

function decodeQuadTree(bytes: Uint8Array): QuadTree<Stroke> | null {
  const reader = new BinaryReader(bytes);
  if (reader.readUint32() !== MAGIC) {
    return null;
  }
  const version = reader.readUint16();
  if (version < 1 || version > VERSION) return null;

  return QuadTree.fromSnapshot(readNode(reader, version));
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
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
  if (!("CompressionStream" in window)) {
    return { blob: new Blob([bytes], { type: "application/octet-stream" }), compression: "none" };
  }

  const compressedStream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return {
    blob: await new Response(compressedStream).blob(),
    compression: "gzip",
  };
}

async function decompress(snapshot: StoredSnapshot): Promise<Uint8Array> {
  const stream = snapshot.compression === "gzip"
    ? snapshot.blob.stream().pipeThrough(new DecompressionStream("gzip"))
    : snapshot.blob.stream();
  return new Uint8Array(await new Response(stream).arrayBuffer());
}


function writeNode(writer: BinaryWriter, node: QuadTreeSnapshot<Stroke>): void {
  writeBounds(writer, node.bounds);
  writer.writeUint32(node.items.length);
  node.items.forEach((stroke) => writeStroke(writer, stroke));
  writer.writeUint8(node.children ? 1 : 0);
  node.children?.forEach((child) => writeNode(writer, child));
}

function readNode(reader: BinaryReader, version: number): QuadTreeSnapshot<Stroke> {
  const bounds = readBounds(reader);
  const itemCount = reader.readUint32();
  const items = Array.from({ length: itemCount }, () => readStroke(reader, version));
  const hasChildren = reader.readUint8() === 1;
  const children = hasChildren ? Array.from({ length: 4 }, () => readNode(reader, version)) : undefined;

  return { bounds, items, children };
}

function writeStroke(writer: BinaryWriter, stroke: Stroke): void {
  writer.writeUint32(stroke.id);
  writer.writeUint8(stroke.kind === "eraser" ? 1 : 0);
  writer.writeFloat32(stroke.width);
  writer.writeFloat32(stroke.softness ?? 0);
  writer.writeUint32(stroke.segments?.length ?? 0);
  stroke.segments?.forEach((segment) => writeSegment(writer, segment));
  writer.writeString(stroke.color);
  writer.writeUint32(stroke.points.length);

  for (const point of stroke.points) {
    writer.writeFloat64(point.x);
    writer.writeFloat64(point.y);
    writer.writeFloat64(point.time ?? Number.NaN);
    writer.writeFloat32(point.strength ?? Number.NaN);
  }
}

function readStroke(reader: BinaryReader, version: number): Stroke {
  const id = reader.readUint32();
  const kind = reader.readUint8() === 1 ? "eraser" : "stroke";
  const width = reader.readFloat32();
  const softness = version >= 4 ? reader.readFloat32() : 0;
  if (version === 2) reader.readFloat32(); // Version 2 stored a per-stroke width.
  const segments = version >= 5 ? readSegments(reader) : undefined;
  const color = reader.readString();
  const pointCount = reader.readUint32();
  const points: Point[] = [];

  for (let index = 0; index < pointCount; index++) {
    const x = reader.readFloat64();
    const y = reader.readFloat64();
    const time = reader.readFloat64();
    const strength = version >= 3 ? reader.readFloat32() : Number.NaN;
    points.push({
      x,
      y,
      time: Number.isNaN(time) ? undefined : time,
      strength: Number.isNaN(strength) ? undefined : strength,
    });
  }

  return {
    id,
    kind,
    color,
    width,
    softness,
    segments,
    points,
    bounds: boundsFromPoints(points, width),
  };
}

function writeSegment(writer: BinaryWriter, segment: CubicSegment): void {
  writePoint(writer, segment.start);
  writePoint(writer, segment.controlOne);
  writePoint(writer, segment.controlTwo);
  writePoint(writer, segment.end);
  writer.writeFloat32(segment.width);
}

function readSegments(reader: BinaryReader): CubicSegment[] {
  const segmentCount = reader.readUint32();
  return Array.from({ length: segmentCount }, () => ({
    start: readPoint(reader),
    controlOne: readPoint(reader),
    controlTwo: readPoint(reader),
    end: readPoint(reader),
    width: reader.readFloat32(),
  }));
}

function writePoint(writer: BinaryWriter, point: Point): void {
  writer.writeFloat64(point.x);
  writer.writeFloat64(point.y);
}

function readPoint(reader: BinaryReader): Point {
  return { x: reader.readFloat64(), y: reader.readFloat64() };
}

function writeBounds(writer: BinaryWriter, bounds: QuadTreeSnapshot<Stroke>["bounds"]): void {
  writer.writeFloat64(bounds.x);
  writer.writeFloat64(bounds.y);
  writer.writeFloat64(bounds.width);
  writer.writeFloat64(bounds.height);
}

function readBounds(reader: BinaryReader): QuadTreeSnapshot<Stroke>["bounds"] {
  return {
    x: reader.readFloat64(),
    y: reader.readFloat64(),
    width: reader.readFloat64(),
    height: reader.readFloat64(),
  };
}

class BinaryWriter {
  private buffer = new ArrayBuffer(1_024);
  private view = new DataView(this.buffer);
  private position = 0;
  private readonly textEncoder = new TextEncoder();

  writeUint8(value: number): void { this.writeNumber(1, (view, offset) => view.setUint8(offset, value)); }
  writeUint16(value: number): void { this.writeNumber(2, (view, offset) => view.setUint16(offset, value, true)); }
  writeUint32(value: number): void { this.writeNumber(4, (view, offset) => view.setUint32(offset, value, true)); }
  writeFloat32(value: number): void { this.writeNumber(4, (view, offset) => view.setFloat32(offset, value, true)); }
  writeFloat64(value: number): void { this.writeNumber(8, (view, offset) => view.setFloat64(offset, value, true)); }

  writeString(value: string): void {
    const bytes = this.textEncoder.encode(value);
    this.writeUint16(bytes.length);
    this.writeBytes(bytes);
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.buffer, 0, this.position);
  }

  private writeNumber(length: number, write: (view: DataView, offset: number) => void): void {
    this.ensureCapacity(length);
    write(this.view, this.position);
    this.position += length;
  }

  private writeBytes(bytes: Uint8Array): void {
    this.ensureCapacity(bytes.length);
    new Uint8Array(this.buffer, this.position, bytes.length).set(bytes);
    this.position += bytes.length;
  }

  private ensureCapacity(required: number): void {
    if (this.position + required <= this.buffer.byteLength) {
      return;
    }

    const expanded = new ArrayBuffer(Math.max(this.buffer.byteLength * 2, this.position + required));
    new Uint8Array(expanded).set(new Uint8Array(this.buffer));
    this.buffer = expanded;
    this.view = new DataView(expanded);
  }
}

class BinaryReader {
  private position = 0;
  private readonly view: DataView;
  private readonly textDecoder = new TextDecoder();

  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  readUint8(): number { return this.readNumber(1, (view, offset) => view.getUint8(offset)); }
  readUint16(): number { return this.readNumber(2, (view, offset) => view.getUint16(offset, true)); }
  readUint32(): number { return this.readNumber(4, (view, offset) => view.getUint32(offset, true)); }
  readFloat32(): number { return this.readNumber(4, (view, offset) => view.getFloat32(offset, true)); }
  readFloat64(): number { return this.readNumber(8, (view, offset) => view.getFloat64(offset, true)); }

  readString(): string {
    const length = this.readUint16();
    const bytes = this.readBytes(length);
    return this.textDecoder.decode(bytes);
  }

  private readNumber(length: number, read: (view: DataView, offset: number) => number): number {
    this.ensureRemaining(length);
    const value = read(this.view, this.position);
    this.position += length;
    return value;
  }

  private readBytes(length: number): Uint8Array {
    this.ensureRemaining(length);
    const bytes = this.bytes.slice(this.position, this.position + length);
    this.position += length;
    return bytes;
  }

  private ensureRemaining(length: number): void {
    if (this.position + length > this.bytes.byteLength) {
      throw new Error("Unexpected end of binary quadtree data");
    }
  }
}
