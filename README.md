# quaddraw

## Architecture

The drawing is an ordered document of raster layers. Each layer owns an
independent sparse raster quadtree rather than a collection of retained vector
paths. Pointer samples are transiently smoothed into cubic B-spline curves, then
flattened into tapered brush capsules that recursively paint immutable quadtree
nodes. Uniform areas remain compressed as one node;
only brush edges subdivide to pixel-sized leaves. The canvas renderer traverses
and fills the visible colored nodes directly.

Undo and redo retain copy-on-write document and tree roots, so unchanged layers
and branches are shared. IndexedDB persistence stores ordered layer metadata,
raster values, and full tree topology in the `QDR3` binary snapshot format.
The compact tree layout packs four node tags per byte,
omits payloads for transparent leaves, and uses a frequency-selected color
palette. Pointer samples are transient and are neither rendered as paths nor
persisted.

Use the `Q` shortcut or the quadtree toolbar button to overlay the live leaf
topology. Outline hue represents depth, and occupied leaves are emphasized over
their transparent siblings.

The Select tool (`V`) treats the raster topology as 8-connected ink islands.
Dragging a marquee selects every complete island touched by it, including ink
outside the marquee; overlapping strokes form one island because vector stroke
identity is intentionally not retained. If the active layer has no matching
ink, selection continues down through the layers, then searches the layers
above the original active layer if it reaches the bottom without a match. The
first matching layer is activated. Dragging inside the selected bounds moves
the ink as one undoable cut-and-composite operation, snapped to the quadtree's
finest raster grid to preserve crisp cell coverage.

## Development

### Setup

Use [mise](https://mise.jdx.dev/getting-started.html) to install all dependencies

```shell
mise install
```

OR install them manually with versions pinned in [.mise.toml](.mise.toml).

See

```shell
task
```

to list all available commands.

<br/>

## Initial Setup

Run the following command to setup the project on your system:

```shell
task setup
```

The setup task can be rerun to update dependencies and configurations.

<br/>
