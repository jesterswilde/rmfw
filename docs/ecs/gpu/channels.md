// docs/ecs/gpu/channels.md

# GPU Channels

This document explains the **ECS → GPU channel layer**, which prepares compact, deterministic buffers for WebGPU from ECS data. Channels minimize GPU uploads through dirty-range coalescing and use **epoch/version tracking** to skip redundant work.

---

## Architecture Overview

### Channel Layers

| Layer | Description |
|--------|-------------|
| **BaseChannel** | Common CPU/GPU buffer management, dirty tracking, and upload logic. |
| **TransformsChannel** | Streams inverse-world transforms in `TransformTree` DFS order. |
| **RenderChannel** | Streams render nodes (ops/shapes) in `RenderTree` DFS order, wiring tree links and transform references. |

All channels are **deterministic** — given identical ECS and tree inputs, they produce byte-identical outputs.

---

## BaseChannel

### Purpose
`BaseChannel` provides:
- CPU-side AoS buffer with `Float32Array` + `Int32Array` views.
- Tracking of dirty ranges for efficient GPU uploads.
- Automatic `GPUBuffer` creation and resizing.

### API Summary

- **layoutEntry(binding, visibility?)** → `GPUBindGroupLayoutEntry`  
  Returns the default read-only storage buffer layout (visibility defaults to `COMPUTE`).

- **createOrResize(device)** → `boolean`  
  Ensures GPU buffer matches CPU buffer size; recreates when needed and marks entire buffer dirty.

- **flush(queue)**  
  Coalesces and uploads dirty ranges via `queue.writeBuffer`.

- **sync(world, args)** → `boolean` *(abstract)*  
  Subclasses implement to populate CPU buffer and mark dirty regions.  
  Returns `true` if a GPU flush is required.

### Key Helpers

- `ensureCpu(rows, rowSizeBytes)` — grows the CPU buffer and typed views.
- `markRowDirty(row)` — marks a single row dirty.
- `markAllDirty()` — marks entire buffer dirty.

### Determinism & Performance

- Deterministic packing — DFS orders define layout.
- Minimal allocations — caches grow but never shrink.
- Dirty-range merging — adjacent runs coalesce into one GPU write.

---

## TransformsChannel

### What It Does
Streams inverse-world transforms in DFS order as contiguous rows of 12 floats (`3×4` matrix, row-major):

```

inv_r00 inv_r01 inv_r02 inv_tx  
inv_r10 inv_r11 inv_r12 inv_ty  
inv_r20 inv_r21 inv_r22 inv_tz

````

### Behavior
- **Full repack** when `orderEpoch` changes.
- **Incremental patch** when per-row `rowVersion` changes.
- Skips redundant uploads if store and order epochs unchanged.

### Layout
- **Row size:** 12×`f32` = 48 bytes.
- **Mapping:** row `i` = entity `order[i]`.

### API
```ts
sync(world, { order, orderEpoch, store }): boolean
````

Where:

- `order` = `TransformTree.order`
    
- `orderEpoch` = `TransformTree.epoch`
    
- `store` = Transform `StoreView`
    

### Notes

- Missing transforms are skipped safely.
    
- Full rebuilds are deterministic.
    
- `rowVersionSeen` tracks last-known state per transform row.
    

---

## RenderChannel

### Overview

The `RenderChannel` streams **render nodes** (ops/shapes/inert) in `RenderTree` DFS order.  
Each row directly maps to the shader’s `PackedNode` struct:  
**4×int32 header + 12×float32 payload = 64 bytes per row.**

### Row Layout

|Slot|Type|Description|
|---|---|---|
|`i32[0]`|`kind`|Encoded type: `0=none`, op type, or shape type|
|`i32[1]`|`firstChild`|Index of first child in render DFS order, or `-1`|
|`i32[2]`|`nextSibling`|Index of next sibling in DFS order, or `-1`|
|`i32[3]`|`flags`|Reserved; currently `0`|
|`f32[0]` (`v0`)|`transformRow` or `childCount` (bitcast from int)||
|`f32[1]` (`v1`)|`materialId` or unused||
|`f32[2..7]`|Shape parameters (`p0..p5`)||
|`f32[8..11]`|Reserved (zeroed)||

### Packing Rules

- **Shapes:**
    
    - `kind` = `shapeType`
        
    - `v0` = transform row index (`bitcast<i32>`)
        
    - `v1` = material id (`-1`)
        
    - `v2..v7` = shape parameters
        
- **Ops:**
    
    - `kind` = `opType`
        
    - `v0` = `childCount` (`bitcast<i32>`)
        
    - Remaining payload zeroed
        
- **Inert:**
    
    - `kind=0`, payload all zeros
        

### Sync Behavior

|Condition|Action|
|---|---|
|Render `orderEpoch` changed|Full rebuild (repack all rows)|
|Shape/op `rowVersion` changed|Incremental rewrite for affected row|
|Parent/child links changed|Recompute `firstChild`, `nextSibling`|
|Transform `orderEpoch` changed|Update only transform indices for shapes|
|Kind changed (component add/remove)|Row rewritten with new kind and cleared payload|

### API

```ts
sync(world, {
  order, orderEpoch,
  shapeStore, opStore, renderStore,
  transformStore,
  transformOrder, transformOrderEpoch
}): boolean
```

### Determinism

- `firstChild` / `nextSibling` derive purely from ECS parent links.
    
- Transform index lookup based on current `TransformTree.order`.
    
- Caches (`entityToRow`, `transformRowLookup`) grow deterministically.
    
- No root-row special logic — `RenderTree` defines all rows.
    

---

## Testing Plan

### TransformsChannel

1. **Full rebuild on order change**
    
    - Swap DFS order, expect full dirty upload.
        
2. **Incremental by rowVersion**
    
    - Modify one transform, expect single-row update.
        
3. **No-ops when unchanged**
    
    - Second sync with same epochs should return `false`.
        
4. **Capacity growth**
    
    - Expanding store resizes internal caches.
        
5. **Determinism**
    
    - Identical input → identical buffer bytes.
        

### RenderChannel

1. **Full rebuild on render order change**
    
    - Change `RenderTree.epoch`; expect full 64×N-byte upload.
        
2. **Incremental shape update**
    
    - Modify shape param and bump version; one-row dirty run.
        
3. **Op child count change**
    
    - Modify children; only parent row updates.
        
4. **Transform reindex only**
    
    - Change transform DFS order; affected shape rows rewrite.
        
5. **Kind transitions**
    
    - Add/remove `Shape` or `Operation` component; correct kind & zeroing.
        
6. **Tree link changes**
    
    - Reparent; updates `firstChild` / `nextSibling`.
        
7. **Entity cache growth**
    
    - Increase entity count; caches resize safely.
        
8. **Inert rows**
    
    - Entities missing both Shape/Op → `kind=0` + zero payload.
        
9. **Deterministic output**
    
    - Stable input produces byte-identical CPU buffer.
        

### BaseChannel Shared Tests

1. **Dirty range coalescing** — Adjacent dirty rows merge into one upload.
    
2. **Full-buffer path** — `markAllDirty` triggers one full write.
    
3. **Buffer recreation** — Size increase triggers reallocation and full upload.
    
4. **Zero-sized safety** — Empty buffers handled gracefully.
    

---

## Implementation Notes

- **Row Size:** Always 64 bytes for RenderChannel, 48 bytes for TransformsChannel.
    
- **Endian Safety:** Int writes for WGSL bitcasts use shared buffer view.
    
- **No allocations per frame:** All caches are reused.
    
- **Root handled by tree:** Channel never writes a “root row”; `RenderTree` order defines layout.
    
- **Flags reserved:** Currently zero, but future “gate” or “visibility mask” bits can occupy it.
    

---

**Summary:**  
GPU Channels form the bridge between ECS component state and WebGPU buffers.  
They are deterministic, memory-efficient, and minimize GPU traffic by coalescing updates and tracking per-row changes across both component versions and tree epochs.