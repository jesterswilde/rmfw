# EntityAllocator

## Overview
`EntityAllocator` manages the pool of entity IDs. It tracks live entities in dense order, free IDs, and per-entity epochs for structural change detection. It supports densification (remapping live entities to a contiguous 0..N-1 range) and full export/import for persistence.

## API
- `constructor(initialCapacity)` – allocates arrays for sparse mappings, epochs, and free IDs.
- `capacity`, `size`, `dense` – report allocator state and current live ID order.
- `create()` – returns a new ID, reusing one from the free list before allocating new capacity.
- `destroy(id)` – removes the ID, compacts the dense list, adds the ID to the free list, and increments its epoch.
- `isAlive(id)` / `denseIndexOf(id)` – membership and dense index lookups.
- `computeDenseRemap()` – builds a map assigning new dense IDs to all alive entities.
- `applyRemap(remap)` – rewrites allocator structures so live entities occupy 0..N-1, clears free list, and bumps each live entity’s epoch.
- `export()` / `import(data)` – serialize and restore all allocator arrays, sizes, and epochs exactly.

## Testing Plan
### Creation & Growth
- Creating entities increments size and dense list correctly.
- Growth preserves mappings and epochs.

### Destruction & Reuse
- Destroying an entity removes it from dense order, updates sparse entries, and bumps its epoch once.
- Recreating reuses freed IDs before issuing new ones.

### Remap
- `computeDenseRemap()` produces a one-to-one map for all alive entities.
- `applyRemap()` updates all arrays so entity IDs are 0..N-1, resets the free list, bumps epochs once per live entity, and sets `next = size`.

### Export/Import Round Trip
- Export followed by import yields identical allocator state.

### Safety
- Destroying non-live or out-of-range IDs is a no-op.
- `isAlive` and `denseIndexOf` remain safe for all IDs.
