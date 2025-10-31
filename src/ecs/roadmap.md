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

## - [x] Phase 2 — Migrate Systems (CPU-only)
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
- [x] **Save and Load Scene**
  - [x] Can save a scene wih various components
  - [x] Can load a json scene file
  - [x] Can load a scene, then save it, and have the data look right

---

## - [ ] Phase 3 — Generic GPU Bridge (Incremental & Pluggable)
**Outcome:** Reusable CPU→GPU path with partial uploads; channels are modular and bound explicitly.

    - [x] propagateTransforms
        - [x] Compute `world = parent.world × local`
        - [x] Compute `invWorld = inverse(world)` (orthonormal fast path)
        - [x] Clear dirty flag; bump `Transform.storeEpoch`
    - [x] Reparented transforms maintain world-space coordinates
    - [ ] AoS Channels:
        - [X] Implement `TransformsChannel` (inverse world only, 12 f32/row)
        - [ ] Implement `RenderChannel` (ops/shapes, mixed f32/i32 views)
    - [x] GPU Bridge:
        - [x] Explicit (group, binding) registration; no sorting or remap
        - [X] Supports full GPU rewrite or partial range updates
    - [X] Dirty tracking:
        - [X] Incremental path via rowVersion deltas + merged runs to `queue.writeBuffer`
        - [X] Full rewrite fallback when DFS order changes (tree.epoch)
    - [x] Tests:
        - rowVersion → partial upload
        - epoch change → full upload
        - buffer resize → bind group rebuild
        - deterministic DFS packing

**Exit criteria**
- Scene can call `propagateTransforms()` → `bridge.syncAll()` → bind both channels with correct (group,binding)
- Transforms and Render channels have working incremental uploads


## - [ ] Phase 4 — WGSL Hookup (End-to-End)
**Outcome:** Bridge buffers fully replace legacy GPU data; ECS-backed rendering runs end-to-end.

    - [ ] Bind `TransformsChannel.gpuBuffer` → `@group(2) binding(2)`
    - [ ] Bind `RenderChannel.gpuBuffer` → `@group(2) binding(0)`
    - [ ] WGSL shaders updated to consume new buffer layouts
    - [ ] Sample scene renders correctly using ECS + Bridge buffers
    - [ ] Legacy pools (`Mat34Pool`, `NodeTree`, etc.) fully removed

**Exit criteria**
- Scene renders correctly with ECS-backed GPU buffers only


## - [ ] Phase 5 — Archetypes (Storage Swap)
**Outcome:** Replace sparse-set ECS storage with chunked archetypes (signatures → chunks).

    - [ ] Implement `Archetype` chunks
    - [ ] O(1) add/remove moves; queries iterate chunks linearly
    - [ ] Keep meta-driven field definitions; Bridge/systems unchanged
    - [ ] Validate byte-parity with pre-archetype GPU output

**Exit criteria**
- Systems and Bridge require no code changes after swap
- Perf and correctness validated


## - [ ] Phase 6 — Efficient Physical Rebuilds (DFS-aware)
**Outcome:** Hierarchical components rebuild incrementally; avoid full AoS rewrites.

    - [ ] Add subtree-based range repacking (delete/insert contiguous DFS runs)
    - [ ] Explore:
        - AoS gap buffer (splice-based incremental packing)
        - GPU indirection index (stable rows, small index uploads)
        - Subtree “islands” (multiple buffers)
    - [ ] Benchmarks for structural edits

**Exit criteria**
- Reparenting large subtrees triggers ≤2 uploads (delete+insert)
- Significant reduction in GPU upload bytes on structure change


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
