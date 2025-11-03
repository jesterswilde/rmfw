# ComponentStore

## Overview
`ComponentStore` holds component data in a Structure of Arrays (SoA) layout. It manages the mapping between entities and dense rows, tracks per-row and per-store version epochs, and now supports export/import for persistence along with full entity remapping. Link fields are transparently rewritten when entity IDs change, enabling world-level densification and save/load cycles.

## API
- `constructor(meta, initialCapacity?)` – builds typed arrays for all fields in the component meta and initializes capacity (default 256).
- `size`, `capacity`, `entityToDense`, `denseToEntity`, `rowVersion`, `storeEpoch` – expose store stats and mapping/epoch arrays.
- `fields()` – returns the column map keyed by field names.
- `has(entity)` / `denseIndexOf(entity)` – report membership and dense index for an entity.
- `add(entity, init?)` – creates or overwrites the entity’s row, applying defaults and overrides. Increments the row’s version and the store’s epoch.
- `update(entity, patch)` – modifies only changed fields. Returns `true` if something changed (and bumps epochs), or `false` if values were identical.
- `remove(entity)` – swap-removes the entity’s row, fixes mappings, clears the trailing slot, and increments `storeEpoch`.
- `remapEntitiesAndLinks(remap: Int32Array)` – rewrites entity IDs using the provided map. Remaps all link fields (where `meta.fields[i].link === true`) while leaving scalar fields untouched.
- `export()` – returns a full JSON-safe snapshot of the store’s data, including mappings, epochs, and every field array.
- `import(data)` – reconstructs the store state from an export, restoring sizes, arrays, and epochs exactly.

## Testing Plan
### Construction & Growth
- Instantiation builds correctly typed columns sized to capacity.
- Growth preserves field data and mapping integrity.

### Add & Update Behavior
- Adding a new entity fills defaults, applies overrides, and bumps epochs once.
- Re-adding the same entity overwrites its row in place and bumps epochs once.
- Updating with identical values returns `false` and leaves epochs unchanged.
- Updating with changed values returns `true` and bumps both row and store epochs.

### Removal Behavior
- Removing a live entity swap-compacts the store, clears the last slot, and increments `storeEpoch`.
- Removing a missing entity returns `false` and makes no changes.

### Remap Behavior
- After `remapEntitiesAndLinks`:
  - All live entities and link fields follow the new ID mapping.
  - Non-link numeric data is unchanged.
  - `NONE` links remain `NONE`.
  - Store epoch increments once and all affected rows increment their row versions.

### Export/Import Round Trip
- Exporting and importing yield bit-identical results for all arrays, mappings, and epochs.
- Works with both dense and sparse states (pre- and post-`densifyEntities()`).
