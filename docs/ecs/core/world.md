# World

## Overview
`World` coordinates entities, component stores, and trees. It now supports densifying entity IDs across all data, serializing and restoring the entire runtime, and rehydrating trees on load.

## API
- `constructor(cfg?)` – builds a world with a default entity capacity of 1024.
- `register(def, capacity?)` – installs a component definition and returns its `ComponentStore`.
- `store(name)` / `storeOf(meta)` – fetch component stores by name or meta.
- `createEntity()` – allocates a fresh entity ID.
- `destroyEntity(entity)` – removes the entity from all stores and the allocator.
- `destroyEntitySafe(entity, removeFromTrees?)` – guarded destroy that respects protected IDs and optionally detaches subtrees.
- `protectEntity`, `unprotectEntity`, `isEntityProtected` – manage protected IDs.
- `registerTree(name, tree)` / `unregisterTree` / `forEachTree(cb)` – manage tree-like facades.
- `queryView(...components)` – builds a joined view across multiple stores.
- `densifyEntities()` – rebuilds the allocator and all stores so all live entities occupy 0..N-1. Remaps every link field, protected ID, and per-entity epoch.
- `export({ densify = true } = {})` – returns a complete snapshot of the world, including:
  - Allocator state
  - All component store exports
  - Protected ID list
  - Registered tree metadata (for rehydration)
- `import(payload, registry)` – rebuilds a new world from an export using the same component metas and tree definitions.
- `rehydrateTree(name, nodeMeta)` – helper used internally to attach existing stores to restored trees.

## Testing Plan
### Registration
- Registering components creates usable stores and disallows duplicates.
- Lookups by name or meta return the same instance.

### Entity Lifecycle
- Creating entities updates allocator and stores consistently.
- Destroying entities frees IDs and removes component rows.
- `destroyEntitySafe` detaches entities from trees when requested.
- Protected IDs cannot be destroyed until unprotected.

### Densification
- After `densifyEntities`:
  - All live entities are renumbered to 0..N-1.
  - Allocator, stores, and trees reference the same remapped IDs.
  - Link fields and protected sets are correct.
  - Entity epochs are incremented predictably.

### Export/Import Round Trip
- Export then import into a new world reproduces identical allocator, stores, protected IDs, and trees.
- Works whether densification is enabled or not.
- Tree rehydration restores root structure and tree registration without creating new entities.

### Query & Integrity
- Queries return consistent entity and row sets before and after save/load.
- After mixed operations (add, update, densify, export/import), mappings, link fields, and epochs remain correct.
