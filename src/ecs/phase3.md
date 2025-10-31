# What changes with “inverse baked per shape”

- **Transforms no longer define render hierarchy.** We’ll still keep `Transform` for authoring/local editing, but render-time buffers now reference baked inverse rows produced directly from the `Transform` component.
    
- **Render hierarchy moves to Ops only.** Ops hold children (shapes and/or ops). A **root MIN op** will implicitly include “loose” shapes.
    
- **WGSL decoupled from xform indices.** A shape row directly carries the **object→world _and_ world→object** (or only the inverse, per shader) data it needs. No indirection through a transform table is required.
    

# ECS components (minimal, future-proof)

- `Transform` (unchanged SoA fields; used for authoring & tools)
    
- `TransformNode` (kept only for editor/scene graphs; **not** required by renderer)
    
- `RenderNode` (ops-only tree: parent/firstChild/nextSibling + flags)

- `Operation` (opType, gate/meta fields, future AABB/BV data)

- `ShapeLeaf` (shapeType + params)
        

> Rationale: we keep Transform authoring ergonomics and determinism, but sever GPU-time dependency chains.

# Systems (CPU)

1. **propagateTransforms** (authoring space)
    
    - Still computes `world` from parent×local for authoring graph (TransformTree).
        
    - Sets a **dirty flag** per affected entity (including descendants when needed).
        
2. **renderTopologyMaintain** (ops tree)
    
    - Maintains `renderOrder[]` (DFS over `RenderNode` only).
        
    - Tracks `renderTreeEpoch`.
        
    - Assigns **implicit membership** of orphan shapes to the **root MIN op** (internal Handle `ROOT_OP`).
        

> Note: transforms update in-place inside the existing `TransformsChannel`; render rows only point at transform indices. Repack happens on **ops topology** changes (Phase 4 will make this incremental).

# GPU Bridge v2 (shader-agnostic, modular)

We make the bridge **channelized** and **pipeline-agnostic**. Each compute/render pipeline declares the **struct contract** it wants, and the bridge fulfills it by mapping ECS → AoS.

## Channels (first wave)

- **TransformsChannel**
    - Packs inverse-world 3×4 rows from the `Transform` store following `TransformTree.order`.
    - **Dirty:** driven by `Transform.rowVersion` (bumped by `propagateTransforms`).

- **RenderChannel**
    - Row = `{ kind:i32, subtype:i32, parentRow:i32, transformRow:i32, params: f32[6] }`.
    - Rows follow `RenderTree.order` with an implicit root MIN row at index 0. Rootless nodes remap their parent to this root.
    - Shapes populate the `params` payload and reference their baked inverse row via `transformRow`.
    - Ops zero the `params` payload.
    - **Dirty:** driven by `ShapeLeaf` / `Operation` row versions and parent/transform pointer changes.

- **(Optional, later) BV/BoundsChannel**

    - Axis-aligned bounds per node (shape/op) for culling; can be produced incrementally (narrow updates).

## Bridge interfaces

- `GpuBridge.registerPipeline(spec: BridgeSpec)`
    
    - `spec.buffers[]` each describes a required channel (name, WGSL struct layout, binding index, resize policy).
        
    - `spec.packer` maps ECS to AoS rows for that pipeline.
        
    - Multiple pipelines can coexist (raymarcher, culling, particles…), each with **their own spec**.
        
- `Channel<T>.build(ordering)`
    
    - Allocates CPU AoS (ArrayBuffer) & GPUBuffer (resizable).
        
    - Builds `rowToByte[]`, `entityToRow[]`, caches `rowVersion[]`.
        
- `Channel<T>.sync()`
    
    - Computes dirty rows from ECS storeVersions + per-row mirrors.
        
    - **Coalesces spans**; emits `queue.writeBuffer` on contiguous byte ranges.
        
    - Heuristic flip-to-full based on % of rows or total bytes.
        
- `Bridge.syncAll()`
    
    - Calls `packers` that need to run (e.g., ops child lists updated first), then channels’ `sync()` in dependency order.
        

### Why specs?

- Lets us evolve WGSL freely (e.g., swapping transform packing, adding tangent space, materials, or AABBs) **without changing ECS or bridge skeleton**.
    
- Supports multiple compute passes with different bindings & structs.
    

# Packing & ordering

- **TransformsChannel order**: mirrors `TransformTree.order`. Rows are contiguous inverse matrices referenced by render rows.

- **RenderChannel order**: DFS over the render tree with an implicit root MIN row injected at index 0. Each entity row records its parent’s row index (or `0` if it was rootless) and, for shapes, the transform row index.


> On render topology change, we rebuild the RenderChannel AoS. Transform updates only touch their corresponding rows; no repack is required.

# Dirty & epochs (recap with the new model)

- **Per-store:** `Transform.storeEpoch`, `ShapeLeaf.storeEpoch`, `Operation.storeEpoch`.
    
- **Per-row:** `rowVersion[]` mirrors in channels; `Transform.rowVersion` drives the TransformsChannel, while RenderChannel mirrors the latest `ShapeLeaf` / `Operation` row versions per entity.
    
- **Topology:** `renderTreeEpoch`. If changed → rebuild the RenderChannel packing.
    
- **No tree-driven repack for shape transforms**; those are mere **row updates** within TransformsChannel.
    

# Incremental topology (Phase 4 direction)

We’ll prep data structures now:

- **Ops CSR** (rows + child array) with **free-list gaps** reserved per op (small slack) to avoid full tail rewrites on minor edits.
    
- **Edit log**: node insert/remove/reparent emits a minimal set of **child array edit ops**; bridge applies them and touches a few spans only.
    
- Optional **paged child buffer** (fixed-size blocks per node) for truly O(1) inserts—trade memory for stability.
    

# Testing targets (Phase 3 scope)

- **Bake vs authoring:** mutate a parent transform, confirm only affected rows in the TransformsChannel upload and that the RenderChannel keeps stable indices.
    
- **Ops edits:** add/remove a child in the op tree → only ops child buffer and touched op row(s) update.
    
- **Shader swap readiness:** provide a **mock pipeline spec** with different transform packing (e.g., world-only) and confirm channels re-pack without ECS changes.
    
- **Root MIN behavior:** shapes not attached to any op appear exactly once via root’s child list.
    

# Integration with current `Scene`

- `@group(2)` now binds:

    - `binding(0)` → `RenderChannel.gpuBuffer`

    - `binding(1)` → `TransformsChannel.gpuBuffer`

    - (Later) `binding(2)` → `BoundsChannel.gpuBuffer`
        
- Scene’s update:

    1. `propagateTransforms()` (authoring)

    2. `bridge.syncAll()` (Transforms first, then Render)

    3. re-create group(2) **only if** any GPUBuffer identity changed (grow).
        

# Modularity for “other compute shaders”

- Each compute pass registers **its own BridgeSpec** (buffers + packer).
    
- Channels are reusable primitives (Render/Transforms channels share the same `BaseChannel`; packers remain pipeline-specific).
    
- We can host **multiple group(2) layouts** per pipeline, or share buffers between pipelines when the layouts match.
    

---

## Milestones to implement

1. TransformsChannel partial updates (inverse baking from `propagateTransforms`)

2. RenderChannel with parent + transform index wiring

3. Bounds/child buffers deferred to Phase 4 (keep notes for future OpsChannel work)
    
4. `GpuBridge` with **spec-based registration**; wire into `Scene`
    
5. Tests for bake/partial/tree-rebuild + root MIN behavior


-----------------------------------