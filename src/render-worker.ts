/**
 * Creates a self-contained worker from typechecked code. A Blob URL avoids a
 * second-entrypoint routing mismatch between Bun's dev server and production.
 */
export function createRenderWorker(): Worker {
  const source = `(${renderWorkerMain.toString()})()`;
  return new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
}

function renderWorkerMain(): void {
  const packedCellBytes = 20;
  const packedDebugRegionFloats = 6;
  const canvas = new OffscreenCanvas(1, 1);
  const context = canvas.getContext("2d")!;
  let pendingRequest: {
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
  } | null = null;
  let renderScheduled = false;

  globalThis.addEventListener("message", (event: MessageEvent<typeof pendingRequest>) => {
    if (!event.data || event.data.type !== "render") return;
    pendingRequest = event.data;
    if (renderScheduled) return;
    renderScheduled = true;
    globalThis.setTimeout(renderLatestRequest, 0);
  });

  function renderLatestRequest(): void {
    renderScheduled = false;
    const request = pendingRequest;
    pendingRequest = null;
    if (!request) return;

    if (canvas.width !== request.width || canvas.height !== request.height) {
      canvas.width = request.width;
      canvas.height = request.height;
    }
    context.setTransform(request.pixelScale, 0, 0, request.pixelScale, 0, 0);
    context.clearRect(0, 0, request.width / request.pixelScale, request.height / request.pixelScale);
    context.save();
    context.translate(request.cameraX + request.marginX, request.cameraY + request.marginY);
    context.scale(request.zoom, request.zoom);
    drawCells(request.cells);
    drawDebugRegions(request.debugRegions, request.zoom);
    context.restore();

    const bitmap = canvas.transferToImageBitmap();
    workerPostMessage({ type: "rendered", id: request.id, bitmap }, [bitmap]);

    // Coalesce messages received while rasterizing and render only the newest.
    if (pendingRequest && !renderScheduled) {
      renderScheduled = true;
      globalThis.setTimeout(renderLatestRequest, 0);
    }
  }

  function drawCells(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    const regionsByColor = new Map<number, number[]>();
    const count = buffer.byteLength / packedCellBytes;
    for (let index = 0; index < count; index++) {
      const offset = index * packedCellBytes;
      const color = view.getUint32(offset + 16, true);
      const regions = regionsByColor.get(color);
      if (regions) regions.push(offset);
      else regionsByColor.set(color, [offset]);
    }

    regionsByColor.forEach((regions, color) => {
      context.beginPath();
      for (const offset of regions) {
        context.rect(
          view.getFloat32(offset, true),
          view.getFloat32(offset + 4, true),
          view.getFloat32(offset + 8, true),
          view.getFloat32(offset + 12, true),
        );
      }
      context.fillStyle = rgbaToCss(color);
      context.fill();
    });
  }

  function drawDebugRegions(buffer: ArrayBuffer, zoom: number): void {
    if (buffer.byteLength === 0) return;
    const regions = new Float32Array(buffer);
    context.save();
    context.lineWidth = 1 / zoom;
    for (let index = 0; index < regions.length; index += packedDebugRegionFloats) {
      const depth = regions[index + 4];
      const occupied = regions[index + 5] !== 0;
      const hue = 255 + (depth * 17) % 95;
      context.strokeStyle = `hsl(${hue} 82% 48% / ${occupied ? 0.62 : 0.24})`;
      context.strokeRect(regions[index], regions[index + 1], regions[index + 2], regions[index + 3]);
    }
    context.restore();
  }

  function rgbaToCss(color: number): string {
    const red = (color >>> 24) & 0xff;
    const green = (color >>> 16) & 0xff;
    const blue = (color >>> 8) & 0xff;
    const alpha = color & 0xff;
    return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
  }

  function workerPostMessage(
    message: { type: "rendered"; id: number; bitmap: ImageBitmap },
    transfer: Transferable[],
  ): void {
    (globalThis as unknown as {
      postMessage(message: { type: "rendered"; id: number; bitmap: ImageBitmap }, transfer: Transferable[]): void;
    }).postMessage(message, transfer);
  }
}
