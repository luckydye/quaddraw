import { RasterQuadTree } from "./quadtree";
import { WORLD_BOUNDS } from "./types";

export type LayerId = number;

/** One independently editable sparse raster in a drawing document. */
export type DrawingLayer = {
  readonly id: LayerId;
  readonly name: string;
  readonly visible: boolean;
  readonly opacity: number;
  readonly tree: RasterQuadTree;
  readonly strokeCount: number;
};

/**
 * Persistent drawing state. Layers are stored in paint order, from bottom to
 * top, and tree roots remain immutable so whole-document history stays cheap.
 */
export type DrawingDocument = {
  readonly layers: readonly DrawingLayer[];
  readonly activeLayerId: LayerId;
  readonly nextLayerId: LayerId;
};

export type LayerInfo = Omit<DrawingLayer, "tree">;

export function createDrawingDocument(
  tree = new RasterQuadTree(WORLD_BOUNDS),
  strokeCount = 0,
): DrawingDocument {
  return {
    layers: [{
      id: 1,
      name: "Layer 1",
      visible: true,
      opacity: 1,
      tree,
      strokeCount,
    }],
    activeLayerId: 1,
    nextLayerId: 2,
  };
}

export function activeLayer(document: DrawingDocument): DrawingLayer {
  const layer = document.layers.find(({ id }) => id === document.activeLayerId);
  if (!layer) throw new Error(`Active drawing layer ${document.activeLayerId} does not exist`);
  return layer;
}

export function replaceLayer(
  document: DrawingDocument,
  layerId: LayerId,
  replace: (layer: DrawingLayer) => DrawingLayer,
): DrawingDocument {
  let found = false;
  let changed = false;
  const layers = document.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    found = true;
    const next = replace(layer);
    changed ||= next !== layer;
    return next;
  });
  if (!found) throw new Error(`Drawing layer ${layerId} does not exist`);
  return changed ? { ...document, layers } : document;
}
