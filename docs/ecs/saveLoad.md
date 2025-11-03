# Save & Load (JSON)

RMFW can save and load to JSON. It aligns with our SoA stores, link-field semantics, and the “densify then serialize” default. The design minimizes churn and preserves runtime structure for fast import.

---

## Overview

- `World.export({ densify = true })` → plain JSON snapshot of:
  - **Allocator** (entity ids, free list, epochs)
  - **Component stores** (one array per field, plus mappings & versions)
  - **Protected ids** (Set → array)
- `World.import(snapshot)` → rebuilds allocator & stores exactly as saved.
- Densification:
  - By default, `export()` computes a stable old→new id remap based on ascending old ids:
    - Remaps component mappings and link fields
    - Remaps the protected set
    - Applies remap to the allocator
  - You can skip densify (`export({ densify:false })`) to save the sparse, in-flight runtime layout.

Determinism: With densify, live ids become contiguous 0..N-1 in ascending-old-id order. This ensures stable, compact saves and repeatable diffs.

---

## JSON Shape

Type structure of the saved snapshot:

type WorldSnapshot = {
  allocator: {
    _dense: number[];
    _sparse: number[];
    _free: number[];
    _next: number;
    entityEpoch: number[];
  };

  components: {
    [name: string]: {
      name: string;
      size: number;
      capacity: number;
      storeEpoch: number;
      entityToDense: number[];
      denseToEntity: number[];
      rowVersion: number[];
      fields: { [key: string]: number[] };
    };
  };

  protectedIds: number[];
};

### Notes

- Fields hold typed scalars serialized as plain number[] in field order defined by meta.
- Link fields (meta flag link: true) are pre-remapped during export densify.
- Non-densified export preserves whatever sparse allocator and store mappings exist at runtime.

---

## API Reference

### world.export(opts?: { densify?: boolean }): WorldSnapshot

- Default: { densify: true } – compacts ids, rewrites link fields & mappings, remaps protected set, then serializes.
- When to disable densify:
  - Debugging live layouts
  - Incremental or streaming saves that must match in-flight ids

Behavior with densify: true

1. Build remap (ascending by old id): oldId -> newId.
2. For each store:
   - Update denseToEntity to newId
   - Rebuild entityToDense for newId
   - Rewrite every link: true field using remap
   - Bump row versions once and storeEpoch once
3. Remap world’s protected set
4. Apply remap to EntityAllocator

Output: a pure-JSON snapshot ready for JSON.stringify.

---

### world.import(snapshot: WorldSnapshot): void

- Restores the allocator (_dense, _sparse, _free, _next, entityEpoch).
- For each pre-registered store, calls store.import(...).
- Restores the protected set exactly.

Stores must already be registered with metas consistent with the snapshot.

---

## Component Store Serialization

Each ComponentStore serializes as:

- entityToDense, denseToEntity, rowVersion, storeEpoch
- One array per field (SoA), keyed by FieldMeta.key
- size and capacity to rehydrate buffers

Link fields are plain integer arrays; their values are already correct in the snapshot because the world remaps them (if densify is enabled). If you export without densify, they reflect current runtime ids.

---

## Allocator Serialization

The allocator emits its live/dense set, free list, sparse mapping, next-id, and per-entity epochs. On import, these are loaded verbatim, preserving identity assignment and version tracking.

When densify is enabled, entity ids are compacted to 0..size-1, the free list is cleared, and epochs for live ids are bumped by +1.

---

## Protected Set

The world’s protected ids serialize to a number array:

- With densify: ids are already remapped
- Without densify: ids are saved exactly as-is

On import, they are restored into the world’s protected set.

---

## Trees & Rehydration

For tree-like components (e.g. TransformNode):

- The node store is rehydrated by World.import.
- Rebuilding convenience structures (like cached DFS order) is the tree’s responsibility.

Recommended static helper:

static rehydrate(world: World, nodeMeta: Meta, rootEntityId: number): TransformTree;

Steps:
1. World.import(snapshot)
2. Call Tree.rehydrate(...) for each tree type present
3. Inside rehydrate, rebuild traversal order & re-register tree hook.

---

## Examples

### Save to JSON (densified)

const snapshot = world.export();
const json = JSON.stringify(snapshot);

### Save without densify

const snapshot = world.export({ densify: false });
const json = JSON.stringify(snapshot);

### Load from JSON

const snapshot = JSON.parse(json) as WorldSnapshot;
const world = initWorld();
world.import(snapshot);
TransformTree.rehydrate(world, TransformNodeMeta, world.store("TransformNode").denseToEntity[0]!);

---

## Testing Plan

1. Round Trip Densified
   - Create entities, link fields, protected ids.
   - Export → Import → Validate mapping, links, epochs.

2. Round Trip Sparse
   - Export with { densify:false }.
   - Import → Ensure identical allocator and stores.

3. Mixed Stores
   - Multiple components, differing capacities.

4. Tree Rehydrate
   - Validate re-registration of trees after import.

5. Compatibility Checks
   - Missing metas throw.
   - Extra fields ignored (no schema drift support).

6. Tree Enumeration
   - Snapshot 'trees' array lists each registered trees once (prefers componentName overrides).

---

## Conventions

- Use -1 for invalid ids (never undefined).
- Metas are immutable schemas.
- Use snapshot capacity to pre-size stores.
- Default densify for deterministic stable saves.
