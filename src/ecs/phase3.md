# What changes with “inverse baked per shape”

- **Transforms no longer define render hierarchy.** We’ll still keep `Transform` for authoring/local editing, but **render-time matrices are pre-baked per shape**.
    
- **Render hierarchy moves to Ops only.** Ops hold children (shapes and/or ops). A **root MIN op** will implicitly include “loose” shapes.
    
- **WGSL decoupled from xform indices.** A shape row directly carries the **object→world _and_ world→object** (or only the inverse, per shader) data it needs. No indirection through a transform table is required.
    

# ECS components (minimal, future-proof)

- `Transform` (unchanged SoA fields; used for authoring & tools)
    
- `TransformNode` (kept only for editor/scene graphs; **not** required by renderer)
    
- `RenderNode` (ops-only tree: parent/firstChild/nextSibling + flags)
    
- `Operation` (opType, gate/meta fields, future AABB/BV data)
    
- `ShapeLeaf` (shapeType + params)
    
- **New:** `BakedXform` (baked 3×4 world and/or inverse for each shape leaf)
    
    - Populated by `propagateTransforms` (authoring) + **bake pass** per shape
        
    - Stored SoA but packed AoS alongside each shape row
        

> Rationale: we keep Transform authoring ergonomics and determinism, but sever GPU-time dependency chains.

# Systems (CPU)

1. **propagateTransforms** (authoring space)
    
    - Still computes `world` from parent×local for authoring graph (TransformTree).
        
    - Sets a **dirty flag** per affected entity (including descendants when needed).
        
2. **bakeShapeXforms**
    
    - For every `ShapeLeaf` with dirty `Transform` (or ancestor change), write/refresh its `BakedXform` row:
        
        - If authoring tree exists: use resolved `world` of that entity.
            
        - If shapes are authoring-roots: use their local as world.
            
    - Computes **inverse (rigid fast path)** and clears dirty.
        
3. **renderTopologyMaintain** (ops tree)
    
    - Maintains `renderOrder[]` (DFS over `RenderNode` only).
        
    - Tracks `renderTreeEpoch`.
        
    - Assigns **implicit membership** of orphan shapes to the **root MIN op** (internal Handle `ROOT_OP`).
        

> Note: **No repack** just because transforms changed; only `BakedXform` rows update. Repack happens on **ops topology** changes (Phase 4 will make this incremental).

# GPU Bridge v2 (shader-agnostic, modular)

We make the bridge **channelized** and **pipeline-agnostic**. Each compute/render pipeline declares the **struct contract** it wants, and the bridge fulfills it by mapping ECS → AoS.

## Channels (first wave)

- **ShapesChannel** (primary)  
    **Row = { header, params, bakedXform }**
    
    - `header: vec4<i32>` — `{ shapeType, material, flags, padding_or_childCount }`
        
    - `params: vec4<f32> * N` — sphere r, box dims, etc. (meta-driven)
        
    - `bakedXform: Transform3x4Inv` (or both W and Inv per pipeline spec)
        
    - **Dirty:** changes in `ShapeLeaf` or `BakedXform` bump per-row version → partial writes.
        
- **OpsChannel**  
    Row holds **op type + child range** (CSR-like):
    
    - `ops: array<OpRow>` with `{ opType:i32, firstChild:i32, childCount:i32, flags:u32 }`
        
    - `opChildren: array<i32>` — flat child indices referencing **ShapesChannel rows or other Ops**
        
    - **Dirty:** topology or op params → may require range update; if child array grows/shrinks, we rewrite the **child tail** only.
        
- **(Optional, later) BV/BoundsChannel**
    
    - Axis-aligned bounds per node (shape/op) for culling; can be produced incrementally (narrow updates).
        

> We drop the dedicated `TransformsChannel` for this shader. If another pipeline wants separated transforms, it can add a **TransformChannel module** (see “multi-pipeline modularity”).

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

- **ShapesChannel order**: stable, deterministic — **first loose shapes**, then DFS over ops with children (or vice versa; we’ll pick and freeze a policy).
    
    - Each shape row gets **its baked inverse** inline; **no pointer chasing** in WGSL.
        
- **OpsChannel order**: DFS over op tree. Children lists refer to **ShapesChannel indices** (and nested op indices). Root MIN op’s child list includes all loose shapes.
    

> On ops topology change, we **rebuild only OpsChannel** (rows + child buffer). ShapesChannel indices remain stable unless we explicitly choose to keep them packed tightly (tuneable).

# Dirty & epochs (recap with the new model)

- **Per-store:** `Transform.storeEpoch`, `ShapeLeaf.storeEpoch`, `Operation.storeEpoch`.
    
- **Per-row:** `rowVersion[]` mirrors in channels; **BakedXform.rowVersion`** updates when transform-derived data changes.
    
- **Topology:** `renderTreeEpoch`. If changed → rebuild **OpsChannel** (not necessarily ShapesChannel).
    
- **No tree-driven repack for shape transforms**; those are mere **row updates** within ShapesChannel.
    

# Incremental topology (Phase 4 direction)

We’ll prep data structures now:

- **Ops CSR** (rows + child array) with **free-list gaps** reserved per op (small slack) to avoid full tail rewrites on minor edits.
    
- **Edit log**: node insert/remove/reparent emits a minimal set of **child array edit ops**; bridge applies them and touches a few spans only.
    
- Optional **paged child buffer** (fixed-size blocks per node) for truly O(1) inserts—trade memory for stability.
    

# Testing targets (Phase 3 scope)

- **Bake vs authoring:** mutate a parent transform, confirm only affected shapes’ `BakedXform` rows upload.
    
- **Ops edits:** add/remove a child in the op tree → only ops child buffer and touched op row(s) update.
    
- **Shader swap readiness:** provide a **mock pipeline spec** with different `bakedXform` layout (e.g., world-only) and confirm channel re-packs without ECS changes.
    
- **Root MIN behavior:** shapes not attached to any op appear exactly once via root’s child list.
    

# Integration with current `Scene`

- `@group(2)` now binds:
    
    - `binding(0)` → `ShapesChannel.gpuBuffer`
        
    - `binding(1)` → `OpsChannel.opsBuffer`
        
    - `binding(2)` → `OpsChannel.childBuffer`
        
    - (Later) `binding(3)` → `BoundsChannel.gpuBuffer`
        
- Scene’s update:
    
    1. `propagateTransforms()` (authoring)
        
    2. `bakeShapeXforms()` (populate/refresh `BakedXform`)
        
    3. `bridge.syncAll()` (Shapes first, Ops next)
        
    4. re-create group(2) **only if** any GPUBuffer identity changed (grow).
        

# Modularity for “other compute shaders”

- Each compute pass registers **its own BridgeSpec** (buffers + packer).
    
- Channels are reusable primitives (ShapesChannel is generic; only its `packer.encodeRow()` differs by spec).
    
- We can host **multiple group(2) layouts** per pipeline, or share buffers between pipelines when the layouts match.
    

---

## Milestones to implement

1. `bakeShapeXforms` (+ fast-path inverse, fallback general inverse)
    
2. `ShapesChannel` v2 (inline baked inverse) + partial updates
    
3. `OpsChannel` (rows + child buffer) + rebuild-on-topology-change
    
4. `GpuBridge` with **spec-based registration**; wire into `Scene`
    
5. Tests for bake/partial/tree-rebuild + root MIN behavior


-----------------------------------