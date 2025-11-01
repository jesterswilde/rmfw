# Phase 4 — WGSL Hookup Outline

## Objective
Complete the end-to-end swap from legacy pools to the ECS + GPU bridge so the compute renderer consumes the new buffers directly and renders the sample scene.

## High-Level Flow After Phase 4
1. `Scene` owns a single ECS `World`, hierarchy trees, and the GPU bridge channels (render + transforms).
2. JSON scenes load through `src/ecs/load.ts`, filling component stores and rebuilding DFS orders.
3. Each frame: propagate transforms → bridge syncs CPU AoS → Scene rebuilds group(2) bind group if buffers changed → compute dispatch reads the ECS buffers.
4. WGSL reads packed render rows + transform rows at the bindings defined in Phase 3 (render @group(2)/binding(0), transforms @group(2)/binding(2)).

## Implementation Steps

### 1. Replace legacy Scene pools with the ECS world
- Files: `src/scene/scene.ts`, `src/scene/engine.ts`.
- Instantiate `initWorld()` inside `Scene`; keep references to `TransformTree`/`RenderTree` from `buildAllHierarchyTrees`.
- Drop `NodeTree`, `ShapePool`, `Mat34Pool` fields and version tracking. Replace with ECS stores + trees + `GpuBridge`, `RenderChannel`, `TransformsChannel`, and a `PropagateWorkspace`.
- Ensure engine bootstraps without pool creation (constructor and `loadScene` paths).

### 2. Load JSON scenes through the ECS loader
- Files: `src/scene/scene.ts`, `src/ecs/load.ts` (reuse as-is).
- Replace `parseScene`/`ShapePool` usage with `loadScene(world, json)` returning entity count + trees.
- After load, cache tree instances, re-run `bridge.register(...)` if world recreated, and prime render/transform order references for frame use.

### 3. Frame update loop drives ECS systems and bridge
- Files: `src/scene/scene.ts`, `src/ecs/systems/propagateTransforms.ts`, `src/ecs/gpu/bridge.ts`.
- On `Scene.update(dt)`: call `propagateTransforms(world, workspace)`; if any structural edits occurred, rebuild DFS orders (`tree.rebuildOrder()` when `tree.dirty` flags or entityEpoch bumps are detected).
- Call `bridge.syncAll(world, device, queue)` each frame. Extend `GpuBridge.syncAll` to report whether any channel recreated its GPU buffer so `Scene` can rebuild the group(2) bind group only when necessary.
- Track counts (`numRenderRows`, `numShapes`) from stores/tree order rather than legacy pool size for frame UBO uploads.

### 4. Bind groups & pipeline layout sourced from the bridge
- Files: `src/scene/computeRenderer.ts`, `src/scene/scene.ts`, `src/ecs/gpu/bridge.ts`.
- Ask `GpuBridge` for `layoutEntriesFor(2)` and `bindGroupEntriesFor(2)`; build the `sceneLayout` and bind group from those arrays instead of hardcoding 3 storage buffers.
- After every bridge sync that reallocates a buffer, refresh the `Scene` bind group with new entries so the compute pass sees up-to-date buffers.
- Keep per-view (group(1)) and out (group(0)) binding logic unchanged.

### 5. Update WGSL to consume ECS-packed buffers
- File: `src/wgsl/main.wgsl` (and any shaders referencing scene buffers).
- Replace `PackedShape`/`Node`/`Transform3x4` structures with the ECS layout:
  - `RenderRow` struct mapping the 10-lane layout (kind, type, parentRow, transformRow, params[6]). Row 0 = implicit MIN op.
  - `TransformRow` struct containing 3x4 inverse matrix rows from `TransformsChannel`.
- Update traversal logic to iterate rows in DFS order using parentRow indices from the render buffer instead of a separate node array.
- Update shape evaluation to fetch params from `RenderRow` and transform index from `RenderRow.transformRow` to index into the transforms buffer.

### 6. Remove or shim legacy pool code paths
- Files: `src/pools/*`, `src/systems/*`, `src/scene/scene.ts`.
- Eliminate direct usage of `ShapePool`, `Mat34Pool`, `NodeTree`, and legacy `propagateTransforms`/`repack`. Keep utilities only if other modules still need them, otherwise gate behind ECS compatibility shims until full removal.
- Ensure external callers (e.g., editor panes) read data from the ECS world or expose adapters.

### 7. Testing & validation
- Add integration coverage:
  - New scene-level test (Jest or Playwright harness) that loads `assets/scene.json`, runs `propagateTransforms` + `bridge.syncAll`, and verifies GPU buffers match expectations (using mock GPU like existing tests).
  - WGSL unit test or shader snapshot to ensure the new structs compile and expected bindings exist.
- Update existing tests that referenced legacy pools to use ECS APIs or drop them once redundant.

## Open Questions / Follow-ups
- Decide whether to expose a helper on `Scene` for editor code to mutate ECS entities (may be deferred to Phase 5/7).
- Determine if additional channels (materials, lights) should register during Phase 4 or remain stubs for later phases.