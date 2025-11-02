# Overview
`EntityAllocator` hands out stable entity ids, keeps sparse and dense mappings in sync, grows its buffers as needed, and bumps a per-entity epoch whenever structure changes so systems can detect updates.

## API
- `constructor(initialCapacity)` – initialises sparse mapping, free list, and epoch arrays sized for the requested capacity (minimum 1).
- `capacity`, `size`, `dense` – expose allocator stats and the dense list of live ids.
- `create()` – returns the next available entity id, reusing ids from the free list before growing the pool.
- `destroy(id)` – removes the id from the dense list, adds it to the free list, updates sparse mappings, and bumps the entity’s epoch.
- `isAlive(id)` – reports whether the id currently has a dense slot.
- `denseIndexOf(id)` – returns the dense index for an entity or `-1` if not live.

## Testing Plan
### Creation Flow
- Creating consecutive entities produces ids in order, fills the dense list, and grows the allocator when the sparse array would otherwise overflow.
- Newly created ids record their dense index in the sparse array and start with epoch zero.

### Destruction and Reuse
- Destroying an entity in the middle of the dense list moves the last dense id into the gap and updates sparse mappings accordingly.
- Destroyed ids are marked as free, make `isAlive` return false, and make `denseIndexOf` return `-1`.
- Creating after a destroy reuses the freed id before allocating a fresh one.
- Each destroy call bumps the entity epoch exactly once, even after the id is recycled and destroyed again.

### Capacity Growth
- Allocating past the starting capacity resizes the sparse array, epoch array, and free list while keeping existing data intact.
- Destroying ids near the growth boundary still updates mappings and free lists correctly after resizing.

### Safety Checks
- Destroying an id that is already free is a no-op.
- `isAlive` and `denseIndexOf` return safe defaults for ids outside the allocated range, including negative ids and ids above the current capacity.
