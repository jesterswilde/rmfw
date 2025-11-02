# Overview
The `World` is the central hub for the ECS runtime. It owns the entity allocator, registers component stores only when needed, and keeps tree helpers in sync so hierarchies stay tidy. Systems ask the `World` to create and destroy entities, fetch component stores, and perform safe cleanup that respects protected roots.

## API
- `constructor(cfg?: WorldConfig)` – creates a world with an entity pool sized for the requested capacity (default 1024).
- `register(def, initialCapacity?)` – installs a component definition by meta and returns its `ComponentStore`, throwing if the meta was already registered.
- `store(name)` / `storeOf(meta)` – access stores by name or meta and get the live column data plus mappings.
- `createEntity()` – reserves a fresh entity id using the allocator.
- `destroyEntity(entity)` – removes the entity from every store and releases the id.
- `destroyEntitySafe(entity, removeFromTrees?)` – guarded destroy that refuses protected ids, detaches from registered hierarchies when requested, then calls `destroyEntity`.
- `protectEntity` / `unprotectEntity` / `isEntityProtected` – manage a set of ids that may not be destroyed (used for tree roots).
- `registerHierarchy(name, hierarchy)` / `unregisterHierarchy` / `forEachHierarchy` – keep tree facades informed about membership so they can detach subtrees during safe deletion.
- `queryView(...components)` – builds a join across multiple stores, returning the driver name, row count, entity ids, and dense row indices per component.

## Testing Plan
### Registration and Stores
- Registering a component creates the store with the requested starting capacity and makes it available for later lookups.
- Registering the same meta twice throws an error.
- `store(name)` and `storeOf(meta)` return the same live store instance with accurate size, capacity, and mappings.
- Looking up an unknown component by name or meta throws an error.
- Adding enough entities makes the backing stores grow and keeps every column and mapping correct after resizing.

### Entity Lifecycle
- Creating several entities increases the allocator’s dense list and mirrors the allocator arrays.
- Destroying an entity removes its rows from every store, frees the id in the allocator, and lets the id be reused on the next create.
- `destroyEntitySafe` detaches members from every registered hierarchy when asked to remove from trees.
- Protected entities are rejected by `destroyEntitySafe` while `destroyEntity` still allows direct deletion when protection is removed.
- Unregistering a hierarchy stops it from getting destroy callbacks.

### Hierarchy Hooks
- Registered hierarchies receive a remove callback before component teardown when `destroyEntitySafe` is used.
- Unregistered hierarchies no longer receive callbacks.

### Query Joins
- Joining multiple populated stores picks the smallest driver, lines up entity and row arrays, and trims results to the actual match count.
- Joining when one store is empty returns zero rows without errors.
- Joining with entities missing a required component excludes those entities from the result.
- Querying zero components returns an empty view structure.

### Entity Protection and Epochs
- Protecting a root entity blocks safe destruction until it is unprotected.
- Destroying an entity updates the allocator epoch for that id, including after the id is reused.
