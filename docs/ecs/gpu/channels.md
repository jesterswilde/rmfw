// docs/ecs/gpu/channels.md

# GPU Channels

This document covers the ECS → GPU channel layer: reusable CPU-side packing plus channel-specific sync logic that prepares compact, deterministic buffers for WebGPU. Channels minimize uploads via dirty-range coalescing and use epoch/version counters to avoid unnecessary work.

The channel stack has two layers:
- BaseChannel: shared mechanics for CPU AoS storage, dirty tracking, and GPU buffer lifecycle.
- Concrete channels:
  - TransformsChannel: streams inverse-world transforms in TransformTree DFS order.
  - RenderChannel: streams render-node rows (ops/shapes) in RenderTree DFS order, including parenting and transform references.

All channels are deterministic: when a DFS order changes, the channel fully repacks; otherwise, only modified rows get rewritten.

---

## BaseChannel (shared)

Plain-language overview

BaseChannel owns a CPU ArrayBuffer and typed views, tracks dirty row ranges, and manages a corresponding GPUBuffer. Subclasses implement `sync(world, args)` to populate the CPU buffer based on ECS state and mark rows as dirty. BaseChannel then resizes the GPU buffer if needed and flushes dirty ranges with minimal `writeBuffer` calls.

API

- layoutEntry(binding, visibility = GPUShaderStage.COMPUTE) → GPUBindGroupLayoutEntry  
  Default read-only storage buffer layout. Channels can override if they need different visibility or buffer type.
- createOrResize(device: GPUDevice) → boolean  
  Ensures a GPUBuffer exists with the current byte size. Recreates when size changes, marks the entire buffer dirty, and returns true if recreated.
- flush(queue: GPUQueue): void  
  Merges and uploads dirty ranges. Emits a single full upload if the whole buffer is dirty.
- sync(world: World, args: any) → boolean (abstract)  
  Channel-specific packing. Return true when the CPU AoS changed (so a flush is necessary).

Key internal helpers

- ensureCpu(rows: number, rowSizeBytes: number): void  
  Ensures CPU capacity; updates `Float32Array` and `Int32Array` views.
- markRowDirty(rowIndex: number): void  
  Tracks a single dirty row; coalesces with the most-recent range when adjacent.
- markAllDirty(): void  
  Marks the full buffer as dirty.

Determinism & performance

- Packing order is dictated strictly by DFS orders from trees.
- Writes are minimized to row runs and single full-buffer uploads when needed.
- No per-frame allocations beyond growth points; arrays are reused.

---

## TransformsChannel

What it does

Streams inverse-world transforms as tightly packed rows in TransformTree DFS order. Each row is 12 float32 values representing a 3×4 inverse matrix in row-major order:

inv_r00 inv_r01 inv_r02 inv_tx inv_r10 inv_r11 inv_r12 inv_ty inv_r20 inv_r21 inv_r22 inv_tz

When the DFS order changes, the channel fully repacks; otherwise, it updates only rows whose `rowVersion` changed.

API

- sync(world, { order, orderEpoch, store }) → boolean  
  - order: Int32Array (TransformTree.order)  
  - orderEpoch: number (TransformTree.epoch)  
  - store: StoreView of Transform (must expose inv_* and rowVersion)  
  Performs a full rebuild if `orderEpoch` changed. Otherwise, compares each entity row’s `rowVersion` with a cached `rowVersionSeen` and rewrites only changed rows, pushing a dirty run.
- Buffer layout: rows × 12 float32 (48 bytes per row)  
  BaseChannel’s `layoutEntry` exposes the buffer as read-only storage by default.

Notes

- Rows for entities missing a Transform are skipped during incremental checks; on full rebuild they simply do not contribute data.
- Epoch gating ensures no spurious uploads when nothing changed.

---

## RenderChannel

What it does

Streams render nodes in RenderTree DFS order with one AoS row per entity plus an implicit root row at index 0. Each row carries:
- Kind (None / Op / Shape) and subtype (e.g., Op type or Shape type)
- Parent row index (in Render DFS space) for hierarchy reconstruction on GPU
- Transform row index (in Transform DFS space) for sampling the correct transform
- Up to six shape parameters (float32 lanes)

The channel performs:
- Full repack when RenderTree order changes
- Incremental updates when shape or op row versions change
- Early-out protection based on store epochs and both Render and Transform order epochs

API

- sync(world, args) → boolean  
  Args:
  - order: Int32Array (RenderTree.order)
  - orderEpoch: number (RenderTree.epoch)
  - shapeStore, opStore, renderStore: StoreViews for shape/op/render-node components (with rowVersion, capacity, storeEpoch)
  - transformStore: StoreView for Transform (used for capacity info if needed)
  - transformOrder: Int32Array (TransformTree.order)
  - transformOrderEpoch: number (TransformTree.epoch)  
  Behavior:  
  - Full rebuild when `orderEpoch` changes (re-emits all rows in DFS order; marks full dirty)  
  - Early-out when shape/op `storeEpoch`, Render `orderEpoch`, and Transform `orderEpoch` haven’t changed  
  - Incremental path rewrites rows where:
    - Kind or subtype differs
    - Parent mapping changed
    - Transform mapping changed
    - Row version changed for the referenced shape/op row
- Buffer layout: per-row 10 lanes (4 int32 + 6 float32)  
  - i32[0] kind, i32[1] subtype, i32[2] parentRow, i32[3] transformRow  
  - f32[4..9] shape params (zeroed for Ops/None)

Determinism & safety

- Parent row is derived from the current Render DFS mapping only.
- Transform row is derived from the Transform DFS mapping only.
- Both DFS order epochs must match to safely early-out; otherwise a full repack or incremental rewrite occurs.
- Entity-to-row caches are resized to world entity capacity and zeroed each sync.

---

## Testing Plan (Channels)

TransformsChannel

- Full rebuild on order change  
  - Create a small tree, run sync, mutate orderEpoch, ensure full repack and full dirty upload.
- Incremental updates by rowVersion  
  - Toggle a single Transform row’s version; expect one contiguous dirty range covering that row’s position in DFS.
- No-ops when storeEpoch unchanged  
  - Call sync twice without changes; expect false and no dirty ranges.
- Capacity growth  
  - Increase Transform store capacity; `rowVersionSeen` should grow without losing previously cached versions.

RenderChannel

- Full rebuild on Render order change  
  - Change RenderTree.epoch; expect markAllDirty and complete buffer rewrite.
- Early-out when nothing changed  
  - Keep shape/op storeEpoch and both order epochs stable; expect sync returns false.
- Incremental updates  
  - Change a single shape row’s values and bump rowVersion; expect exactly that row range to be marked dirty.
- Parent and transform mapping changes  
  - Reparent in Render tree; or change Transform order epoch; expect correct parentRow/transformRow updates and appropriate dirty ranges.
- Kind transitions  
  - Entity switching from Shape→Op or Shape→None should rewrite the specific row and reset lanes accordingly.
- Entity cache growth  
  - Add many entities; ensure internal `entityToRow` and `transformRowLookup` resize and remain initialized to -1 for out-of-range ids.

Shared (BaseChannel)

- Dirty-range coalescing  
  - Mark adjacent rows; flush should merge them into a single writeBuffer call.
- Full-buffer path  
  - markAllDirty leads to a single writeBuffer of the entire AoS.
- Buffer recreate  
  - Increasing byte size triggers `createOrResize` → full dirty → one full write; no leftover dirty ranges afterward.
