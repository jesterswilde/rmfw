# Overview
`ComponentStore` holds the data for one component type using parallel typed arrays. It tracks which entity owns each dense row, keeps mapping tables so lookups stay quick, grows as needed, and offers helpers to add, change, or remove component rows while keeping version counters up to date.

## API
- `constructor(meta, initialCapacity?)` – builds typed columns for every field declared in the meta, primed with the requested capacity (default 256).
- `size`, `capacity`, `entityToDense`, `denseToEntity`, `rowVersion`, `storeEpoch` – expose store statistics and the mapping arrays.
- `fields()` – returns the typed column map keyed by field name.
- `has(entity)` / `denseIndexOf(entity)` – membership queries for sparse entity ids.
- `add(entity, initialValues?)` – creates or overwrites the row for an entity, filling defaults before applying overrides, bumps epochs, and returns the dense index.
- `update(entity, patch)` – applies number or link patches to an existing row, bumping epochs only when a value changes.
- `remove(entity)` – swap-removes the row, updates mapping tables, clears dense slots, and increments the store epoch.

## Testing Plan
### Construction and Growth
- Constructing a store builds typed columns for every meta field filled with default values or zero.
- Adding enough rows past the starting capacity resizes every column, mapping array, and version table without losing data.

### Add Behaviour
- Adding a new entity places it in the next dense slot, seeds defaults, applies overrides, and bumps the store epoch once.
- Adding an existing entity rewrites the same dense slot, applies overrides, and bumps the store epoch once without creating a new row.

### Update Behaviour
- Updating a row changes only the fields in the patch, leaves others alone, and bumps the row version and store epoch when something actually changes.
- Updating a missing entity returns false and leaves all columns and counters untouched.

### Remove Behaviour
- Removing a present entity updates mappings, swaps in the last row when needed, clears the trailing slot, and bumps the store epoch once.
- Removing an absent entity returns false and leaves the store state unchanged.

### Consistency Checks
- After mixed adds, updates, and removes, `size` matches the count of entities that return true from `has`.
- Dense indices and entity ids remain inverses for all live rows.
- Typed columns keep the expected values for each live dense index after any sequence of operations.
