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
- **Expressive Variable Names** We prefer variable names like driverI over d and componentStore or compStore over c.
---

## - [x] Phase 1 — ECS Core (sparse-set) + Registry
**Outcome:** Entities, component registry, SoA columns, queries.  

- [x] Build `World`
  - [x] Entity allocator (dense/sparse)
  - [x] Per-component SoA stores (`add/remove/get`)
  - [x] Query join over required components
- [x] Registry (single place)
  - [x] `Transform`
  - [x] `TransformNode`
  - [x] `RenderNode`
  - [x] `ShapeLeaf`
  - [x] `Operation`
- [x] Epochs
  - [x] `rowVersion`  
  - [x] `entityEpoch[e]` bumps on any mutation  

---

## - [ ] Phase 2 — Migrate Systems (CPU-only)
**Outcome:** Replace legacy systems (`propagateTransform`, `loadScene` ) and create Tree wrappers for hierarchical components.

- [x] **TransformTree**
  - [x] `addChild`, `remove`, `reparent`
  - [x] Maintain `transformOrder[]` (DFS)
  - [x] Maintain `transformTreeEpoch`
- [x] **RenderTree**
  - [x] `addChild`, `remove`, `reparent`
  - [x] Maintain `renderOrder[]` (DFS)
  - [x] Maintain `renderTreeEpoch`
  - [x] Leaves → `ShapeLeaf`; internals → `Operation`
- [ ] **Save and Load Scene**
  - [x] Can save a scene wih various components
  - [x] Can load a json scene file
  - [x] Can load a scene, then save it, and have the data look right

---

## - [ ] Phase 3 — Generic GPU Bridge (Incremental & Pluggable)
**Outcome:** Reusable, partial-update path for CPU→GPU.  

    - [ ] Create a system for having AoS that will map to the GPU version.
      - This should work with the next point:
  - [x] **propagateTransforms**
    - [x] Iterate `transformOrder[]`
    - [x] Compute `world = parent.world × local`
    - [x] Compute `invWorld = inverse(world)` (orthonormal fast path)
    - [x] Clear dirty flag; bump `Transform.storeEpoch`
  - [x] Reparented transforms should maintain their world space coordiantes
  - [ ] Allows for full GPU rewrite or writing only dirty ranges

---
## - [ ] Phase 4 — Efficient physical storage and rebuilding methods
**Outcome:** For hierarchical components (DFS) we should be able to do full and partial restructures. 
- [ ] **repack system migration**
- [ ] Should be able determine efficient ways to keep structures close to DFS order
      It would be cool if there were ways to do this incrementally so it could take up only a few bits of time each frame.
---

## - [ ] Phase 5 — WGSL Hookup (End-to-End)
**Outcome:** Bridge buffers replace legacy GPU data.  

- [ ] Bind `TransformsChannel.gpuBuffer` → `@group(2) binding(2)`
- [ ] Bind `RenderChannel.gpuBuffer` → `@group(2) binding(0)`
- [ ] Smoke test sample scene renders correctly  

---

## - [ ] Phase 6 — Archetypes (Storage Swap)
**Outcome:** Replace sparse-set storage with chunked archetypes.  

- [ ] Implement `Archetype` (signatures → chunks)
- [ ] Move entities O(1) on add/remove
- [ ] Update queries to iterate chunks linearly
- [ ] Verify Bridge + systems need no changes
- [ ] Perf + byte-parity tests  

---

## - [ ] Phase 7 — Editor Wrappers (GameObject)
**Outcome:** Editor-friendly handles + epoch-based change tracking.  

- [ ] `GameObject(world, entity)` API  
- [ ] Accessors for `transform`, `render`  
- [ ] `.epoch` reflects `entityEpoch`
- [ ] Watchlist polling for UI  

---

## - [ ] Phase 8 — Instancing / Copies 
**Outcome:** Draw the same geometry multiple times.  

  - [ ] Allow for copy nodes.
      Copy nodes indert a new position (in wgsl) into a render path to create instances of objects, perhaps multiple of them. 

---

### ✅ Operational Notes
- `Operation` is a first-class component on internal RenderTree nodes.  
- `RenderTree` DFS controls packing order for both shapes and ops.  
- Partial uploads ensure small `writeBuffer` ranges per edit.  
