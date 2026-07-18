export type WorkerRenderRequest = {
  type: "render";
  id: number;
  width: number;
  height: number;
  pixelScale: number;
  cameraX: number;
  cameraY: number;
  zoom: number;
  marginX: number;
  marginY: number;
  cells: ArrayBuffer;
  debugRegions: ArrayBuffer;
};

export type WorkerRenderResult = {
  type: "rendered";
  id: number;
  bitmap: ImageBitmap;
};

export const PACKED_CELL_BYTES = 20;
export const PACKED_DEBUG_REGION_FLOATS = 6;
