# Overview
Does what it says on the tin, saves and loads files into the world. Currently saved to JSON format. `saveScene` walks the world and writes each registered component into a compact JSON structure, while `loadScene` rebuilds entities and components from that payload and restores tree order. Together they give the save-and-restore loop used by the editor.

## API
### `saveScene(world)`
- Collects all entities currently alive and remaps sparse ids to dense indices for stable output.
- Iterates the known component metas (`Transform`, `TransformNode`, `RenderNode`, `ShapeLeaf`, `Operation`), emitting a block per component with presence masks and column-major data.
- Drops all-default columns when `opts.dropDefaultColumns` is true while keeping the presence mask so loaders can still allocate rows.
- Optionally includes root entity hints for transform and render hierarchies when `opts.includeRoots` is set.
- Returns an `RmfwSceneV1` object containing version metadata, entity count, component blocks, and optional root hints.

### `loadScene(world, scene)`
- Validates the scene header, pre-allocates the requested number of entities, and applies each component block using metas registered in the world.
- Skips unknown components or missing columns while still honouring presence masks and meta defaults.
- Normalises optional root hints (legacy `{transform, render}` or name→array maps) and rebuilds DFS orders for every hierarchy registered in the world via `buildAllHierarchyTrees`.
- Returns a summary with the entity count and the constructed hierarchy views to aid callers that need to rebind references.

## Testing Plan
### Saving
- Saving a populated world reports the correct entity count and presence masks for every component.
- Saved columns follow the meta field order, remap entity links through the dense order, and keep number fields unchanged.
- Setting `dropDefaultColumns` removes all-default columns but keeps presence masks so the loader can rebuild rows.
- Setting `includeRoots` writes sorted root indices for transform and render hierarchies.
- Saving an empty world yields zero entities and no component blocks.
- Saving with metas missing from the world omits their blocks without errors.

### Loading
- Loading a valid `RmfwSceneV1` reproduces the original entity count, component rows, and hierarchy order.
- Presence masks with no columns still produce rows filled from meta defaults.
- Unknown component names are ignored without throwing.
- Link columns that were `NONE` in the save remain `-1` after remapping.
- Pre-allocation grows the world stores when needed and keeps all loaded data intact after resizing.

### Round Trip
- Saving a constructed scene, clearing the world, and loading the payload recreates the scene exactly.
- Saving the reloaded scene produces JSON identical to the first save aside from ordering that is allowed to vary.
- Round-tripping a scene with deep transform hierarchies preserves DFS order and parent-child relationships.
