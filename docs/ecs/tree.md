# Overview
The tree module connects 2 ECS component stores into single-root hierarchies. `Tree` bootstraps paired data and node stores, creates a protected root entity, keeps a stable depth-first traversal order, and offers helpers to reparent or remove subtrees. `TransformTree` extends this by updating transform components so entities keep their world-space pose when their parent changes.

## API
### Shared helpers
- `isHierarchyStore(store)` – checks that a store’s meta matches the expected parent, child, and sibling fields.
- `nodeColumns(store)` – narrows the untyped column map to the hierarchy link columns.
- `isAncestor(store, maybeAncestor, node)` – utility for detecting cycles before reparenting.
- `detachFromParent(store, entity)` / `appendChildAtEnd(store, parent, child)` – low-level list rewiring helpers used by the higher-level tree methods.

### `Tree`
- `constructor(world, dataMeta, nodeMeta, rootData)` – registers the metas, allocates the root entity, seeds row 0 in both stores, protects the root, and registers the hierarchy with the world.
- `order` / `epoch` / `root` – expose the cached DFS traversal order, a counter for structural edits, and the root entity id.
- `setParent(entity, parent)` – reparents a member under a new parent (or the root when `parent` is `NONE`) while preventing cycles and preserving sibling order.
- `remove(entity)` – removes a member, splices its children under the root without reordering them, then destroys the entity from the world.
- `dispose()` – unregisters the hierarchy and releases the root’s protection so the world can tear down cleanly.

### `TransformTree`
- `constructor(world, nodeMeta, rootTransformData)` – same bootstrapping as `Tree` but fixes the transform meta for the data store.
- `setParent(entity, parent)` – overrides the base implementation to recompute local matrices so each child keeps its world-space transform relative to the new parent.
- `remove(entity)` – moves children to the root while preserving their world matrices before destroying the entity.

## Testing Plan
### Module Helpers
- `isHierarchyStore` accepts a store with all required link fields and rejects stores with any field missing or incorrectly typed.
- `nodeColumns` returns the five link arrays and writes flow through to the store buffers.
- `isAncestor` blocks reparenting into descendants and handles `NONE` or missing nodes without throwing.
- `detachFromParent` and `appendChildAtEnd` update sibling chains, parent pointers, and `firstChild` or `lastChild` for head, tail, and middle moves.

### Tree Construction and Growth
- Constructing a tree registers both stores, creates a protected root entity at dense row zero, and seeds the initial DFS order with that root.
- Building enough nodes to exceed the starting capacity in either store resizes both stores while keeping all rows and links intact.
- Constructing a second tree with the same metas fails with a registration error.
- Destroying entities through the world triggers the hierarchy callback registered during construction.

### Reparenting
- Reparenting a child under the root or another parent updates parent pointers, sibling chains, DFS order, and bumps the epoch.
- Attempting to reparent the root throws an error.
- Attempting to reparent to a non-member throws an error.
- Attempting to reparent to a descendant throws an error for cycle prevention.
- Reparenting to the current parent performs no work and leaves the epoch unchanged.

### Removal
- Removing a leaf removes it from both stores, frees it in the world allocator, and refreshes DFS order.
- Removing a node with children moves each child to the root in original order and updates parent pointers and DFS order.
- Removing the root throws an error.
- Calling `dispose` unregisters the hierarchy and unprotects the root so the world can delete it later.

### TransformTree
- Reparenting a node with transform components keeps its world matrix the same while updating its local matrix.
- Reparenting when the new parent lacks a transform treats the parent frame as identity and succeeds.
- Removing a node with children keeps each child’s world transform intact after they become root children.
- Mixed trees of transform and non-transform nodes skip missing transform rows without crashing.
- Setting a parent to `NONE` routes to the root entity and still preserves world transforms.
