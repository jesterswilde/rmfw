// docs/ecs/systems/propagateTransforms.md

# Propagate Transforms

A frame-time system that updates each entity’s `Transform` from its parent’s world transform and the entity’s local transform, writing both the **world** (3×4) and **inverse world** (3×4) matrices. It traverses the `TransformNode` tree deterministically, honors per-entity `dirty` flags to skip unnecessary work, and avoids per-frame allocations by reusing a `PropagateWorkspace`.

Use this after:
- Local transform edits (sets `dirty = 1`)
- Structural changes in the `TransformNode` tree (reparent, add/remove nodes)
- Any operation that invalidates world-space values and requires fresh world/inverse

It is safe to call every frame; work is proportional to the number of nodes marked dirty or with dirty ancestors.

---

## API

### `PropagateWorkspace`
A reusable scratch space to eliminate per-frame allocations during traversal. It auto-grows as depth increases.

- Fields (internals, stable across frames):
  - `nodeStack: Int32Array` – DFS node stack (entity ids)
  - `pr00..pr22, ptx, pty, ptz: Float32Array` – parent world rows per depth
  - `dirtyDepth: Int32Array` – cumulative dirtiness by depth (0 = clean)
  - Identity cache: `id_r00..id_r22`, `id_tx`, `id_ty`, `id_tz`
- Methods:
  - `ensure(depthNeeded: number): void` – grows all stacks/buffers to fit the requested depth

### `propagateTransforms(world: World, workspace?: PropagateWorkspace): void`
Runs a deterministic DFS over all `TransformNode` roots (entities with `parent == -1`) in ascending entity id order, computing:
- `world = parent.world × local` when the node is dirty or has a dirty ancestor
- `inverse(world)` using a fast rigid inverse for orthonormal bases and a general 4×4 inverse otherwise
- Clears `dirty` to `0` after updating, bumps the row’s `rowVersion` and the `Transform` store’s `storeEpoch`

Notes:
- If an entity has a `TransformNode` but **no** `Transform`, its subtree still propagates using the parent context (children that have `Transform` will be updated correctly).
- The `workspace` is optional; if omitted, a temporary is created (best practice: reuse one across frames).

---

## Testing Plan

### Correctness: World and Inverse
- Local identity under identity parent yields identity world and identity inverse.
- Nontrivial parent × local composition writes expected world values (compare against known matrices).
- Inverse matches `inverseRigid3x4_into` for orthonormal bases and `inverseGeneral3x4_into` otherwise (tolerance checks).

### Dirty Propagation and Skips
- When only a leaf is `dirty = 1`, update touches that leaf, not its clean siblings or unrelated subtrees.
- When a parent is `dirty = 1`, all descendants recompute world (dirty-by-ancestry), even if their own `dirty` is `0`.
- After a successful update, `dirty` is reset to `0`, `rowVersion` increments exactly once for the updated row, and the `Transform` store’s `storeEpoch` increments once per updated row (aggregate).

### Deterministic Traversal
- Multiple independent roots are processed in ascending entity id order.
- Sibling traversal order is stable across runs (driven by the singly-linked child list with DFS enter/leave logic).

### Partial Component Presence
- Nodes with `TransformNode` but without `Transform`:
  - Do not cause errors
  - Carry-through the parent world context to descendants; children with `Transform` update correctly
- Nodes with `Transform` but missing from the `TransformNode` store (should not occur in a valid tree) are ignored by traversal.

### Structural Changes
- After reparenting (via `TransformTree.setParent`), mark affected nodes dirty and call `propagateTransforms`:
  - Children world transforms reflect the new tree
  - `rowVersion` increments only for nodes whose computed world changed
- Removing a node (via `TransformTree.remove`) then propagating:
  - Remaining structure is consistent; no dangling references affect traversal

### Workspace Growth and Reuse
- Deep trees exceeding the initial stack size cause `ensure` to grow arrays; verify values are preserved after growth.
- Reusing the same `PropagateWorkspace` across multiple runs does not leak old values into new frames.

### Orthonormal vs General Inverse Path
- Provide inputs close to orthonormal (within `ORTHONORMAL_EPS`) → rigid inverse path taken
- Provide slightly skewed bases (beyond `ORTHONORMAL_EPS`) → general inverse path taken
- Both paths produce inverses whose products with world are ~identity (tolerance)

### Store and Epoch Semantics
- Only rows computed in this pass increment their `rowVersion`.
- `Transform` store’s `storeEpoch` increments once per updated row (confirm monotonic increase).
- No updates when everything is clean: `rowVersion` and `storeEpoch` remain unchanged.

### Performance Guardrails
- During a run that does not trigger growth, no new arrays are allocated (inspect GC/mocks if available).
- The number of math operations scales with the number of nodes marked dirty (plus descendants), not with total node count in the clean case.

### Edge Cases
- Empty world (no `TransformNode` or no `Transform`) is a no-op.
- Single-node tree (root only) updates correctly when dirty.
- Very wide shallow trees and very deep skinny trees both propagate correctly and deterministically.
