# ECS + GPU Bridge Roadmap for a WebGPU Raymarcher

## What we’re building

A modern ECS backbone that will plug into a web based game engine and 3D editor.  
Includes:

- Separate `TransformTree` and `RenderTree`
    
- `Shape` and `Operation` components driving rendering
    
- Generic **GPU Bridge** (can do partial buffer updates)
    
- **Single registry** for components and packing logic
    
- Later: Archetypes + Editor wrappers
    

---

## Design philosophy

- **SoA** layout, cache-friendly linear iterations    
- **Deterministic DFS** ordering for rendering
- **Minimal uploads:** epochs + dirty bits → small `writeBuffer` ranges
- **Composable systems:** renderer only knows buffers
- **Define once:** every component in one registry
- Simple to read about code (low abstractions and indirection)
- **Verification** Each phase will be accompanied by a test suite that proves functionality.
---

## - [ ] Phase 1 — ECS Core (sparse-set) + Registry
**Outcome:** Entities, component registry, SoA columns, queries.  

- [ ] Build `World`
  - [ ] Entity allocator (dense/sparse)
  - [ ] Per-component SoA stores (`add/remove/get`)
  - [ ] Query join over required components
- [ ] Registry (single place)
  - [ ] `Transform`
  - [ ] `TransformNode`
  - [ ] `RenderNode`
  - [ ] `ShapeLeaf`
  - [ ] `Operation`
- [ ] Epochs
  - [ ] `storeEpoch` per component type  
  - [ ] optional `rowVersion`  
  - [ ] `entityEpoch[e]` bumps on any mutation  

---

## - [ ] Phase 2 — Migrate Systems (CPU-only)
**Outcome:** Replace legacy systems (`propagateTransform`, `loadScene`, `repack`) before WGSL hookup.  

- [ ] **TransformTree**
  - [ ] `addChild`, `remove`, `reparent`
  - [ ] Maintain `transformOrder[]` (DFS)
  - [ ] Maintain `transformTreeEpoch`
- [ ] **RenderTree**
  - [ ] `addChild`, `remove`, `reparent`
  - [ ] Maintain `renderOrder[]` (DFS)
  - [ ] Maintain `renderTreeEpoch`
  - [ ] Leaves → `ShapeLeaf`; internals → `Operation`
- [ ] **propagateTransforms**
  - [ ] Iterate `transformOrder[]`
  - [ ] Compute `world = parent.world × local`
  - [ ] Compute `invWorld = inverse(world)` (orthonormal fast path)
  - [ ] Clear dirty flag; bump `Transform.storeEpoch`
- [ ] **loadScene (rewrite)**
  - [ ] Parse JSON scene
  - [ ] Create entities
  - [ ] Add `Transform` + `TransformNode`
  - [ ] Add `RenderNode` (build RenderTree)
  - [ ] Add `ShapeLeaf` or `Operation`
  - [ ] Run headless (no GPU yet)
- [ ] **repack (CPU model only)**
  - [ ] Build `PackedShape[]` in Render DFS order  
  - [ ] Build `Transform3x4[]` from `invWorld`  
  - [ ] Stable mapping `entity → transformSlot`
  - [ ] Decide per-channel: stable vs DFS streamed  

---

## - [ ] Phase 3 — Generic GPU Bridge (Incremental & Pluggable)
**Outcome:** Reusable, partial-update path for CPU→GPU.  

- [ ] **Channel interface**
  - [ ] `strideBytes`
  - [ ] `indexing: 'stable'|'streamed'`
  - [ ] `query(world)`
  - [ ] `keyOf(row)`
  - [ ] `isDirtySince(row, lastEpoch)`
  - [ ] `pack(dstI32, dstF32, dstBase, row)`
- [ ] **TransformsChannel (stable)**
  - [ ] Query `[Transform]` in `transformOrder[]`
  - [ ] Pack `invWorld` → `Transform3x4`
  - [ ] Key = entity id
  - [ ] Single-row partial updates
- [ ] **RenderChannel (streamed)**
  - [ ] Walk `renderOrder[]`
  - [ ] Visit `Operation` + `ShapeLeaf`
  - [ ] Pack → `PackedShape` ABI
  - [ ] Keys = order slots
  - [ ] Coalesced range uploads on reorder
- [ ] **Bridge manager**
  - [ ] Track `lastKeys[]`, `lastEpochs[]`
  - [ ] Detect dirty/moved slots
  - [ ] Coalesce adjacent ranges
  - [ ] Perform `queue.writeBuffer` per range  

---

## - [ ] Phase 4 — WGSL Hookup (End-to-End)
**Outcome:** Bridge buffers replace legacy GPU data.  

- [ ] Bind `TransformsChannel.gpuBuffer` → `@group(2) binding(2)`
- [ ] Bind `RenderChannel.gpuBuffer` → `@group(2) binding(0)`
- [ ] If WGSL still needs `nodes[]`, add temporary `RenderNodesChannel`
- [ ] Smoke test sample scene renders correctly  

---

## - [ ] Phase 5 — Archetypes (Storage Swap)
**Outcome:** Replace sparse-set storage with chunked archetypes.  

- [ ] Implement `Archetype` (signatures → chunks)
- [ ] Move entities O(1) on add/remove
- [ ] Update queries to iterate chunks linearly
- [ ] Verify Bridge + systems need no changes
- [ ] Perf + byte-parity tests  

---

## - [ ] Phase 6 — Editor Wrappers (GameObject)
**Outcome:** Editor-friendly handles + epoch-based change tracking.  

- [ ] `GameObject(world, entity)` API  
- [ ] Accessors for `transform`, `render`  
- [ ] `.epoch` reflects `entityEpoch`
- [ ] Watchlist polling for UI  

---

## - [ ] Phase 7 — Instancing / Copies (Optional)
**Outcome:** Draw the same geometry multiple times.  

- [ ] Add `Instance { sourceEntity, transformOverride? }`  
- [ ] Render traversal resolves to `ShapeLeaf` of source  
- [ ] Bridge packs accordingly  

---

### ✅ Operational Notes
- `ShapeLeaf` shares its entity with its `Transform` → no xform field.  
- `Operation` is a first-class component on internal RenderTree nodes.  
- `RenderTree` DFS controls packing order for both shapes and ops.  
- Partial uploads ensure small `writeBuffer` ranges per edit.  
