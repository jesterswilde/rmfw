# Preferences & Collaboration Guidelines — rmfw
## Response Format

- **Always prefer drop-in replacements.**  
  When code changes are requested, output complete file or function replacements that can be pasted directly — **no partial diffs** unless explicitly requested.

- **Minimize churn.**  
  Preserve existing structure, imports, and comments wherever possible.  
  Only refactor when necessary for correctness or consistency with rmfw design.

- **Use plain code blocks** for file output.  
  Each file should be in its own fenced block with its path as a header comment. Avoid canvas.

- **Avoid ambiguity.**  
  Do not use placeholders like `...` or `TODO`; instead, supply fully working code that compiles.

---

## TypeScript & ECS Design Conventions

- **Never leave “possibly undefined” errors.**  
  When the logic ensures safety, use the non-null assertion (`!`).  
  No `?.` on known-safe arrays or entities in performance-critical ECS code.

- **Type hints must be concise and useful.**  
  Prefer slim hover types (e.g., `StoreView<"Transform", "local_tx" | ...>`) over verbose generic chains.

- **Prefer `const` and readonly structures** wherever data shouldn’t mutate (e.g., metas, schemas, defaults).

- **Meta-driven ECS:**  
  Components should describe themselves through `defineMeta()`; no hardcoded or duplicated schema data.  
  Save/load and tree logic should introspect dynamically, never enumerate component names manually.

- **Guard utilities:**  
  Use small structural guards (e.g., `isLinkField()`) instead of broad type imports that trigger TS errors.

---

## Naming & File Conventions

- **Naming:**  
  - Classes → `PascalCase` (`TransformTree`, `World`, `EntityAllocator`)  
  - Instances/variables → `camelCase` (`tTree`, `entityEpoch`)  
  - Constants → `UPPER_SNAKE_CASE` for sentinel values (`NONE`)  
  - Files → `lowerCamelCase.ts` (mirrors existing structure under `/src/ecs`)

- **Component files** live under `/src/ecs/`:
  - `core.ts` → base ECS engine
  - `registry.ts` → component definitions and registration
  - `trees.ts` → hierarchical structure management
  - `save.ts` / `load.ts` → serialization layer
  - `tests/ecs/*` → Jest test suites per system

---

## Coding Style & Safety

- Always use **explicit imports** (no barrel exports unless stable).  
- Keep ECS stores **SoA (Structure-of-Arrays)** for performance.  
- Ensure **deterministic iteration** (e.g., root order = ascending entity id).  
- No “magic” undefined values — always define sentinel constants (e.g., `NONE = -1`).  
- Default transforms must initialize to identity matrices.

---

##  Test Philosophy

- Use **Jest** (not Vitest).  
- Prefer **unit + round-trip tests** (e.g., save → load → save consistency).  
- When type safety is intentionally violated, use  
  `// @ts-expect-error invalid key`  
  to assert the compiler catches it.  
- Tree and registry tests must confirm:
  - DFS order determinism
  - Proper component linking
  - Correct epoch bumping on structural changes

---

## Collaboration Preferences

- Provide clear explanations **before** code when behavior changes.  
- Avoid restating the problem — focus on concise reasoning and working code.  
- Maintain continuity: recall rmfw’s architecture, conventions, and tone.  
- When unsure, prefer **safe, readable correctness** over micro-optimizations.  
- Avoid speculative design; align with established rmfw patterns first.
- When writing or editing tests, if the API of a class or function changed, then the test should change to reflect this. We are early on so we don't need to maintain any API or backwards compatibility. 

---

## AI Output Checklist

Before replying, verify:

1. **Compiles cleanly** — no TypeScript or ESLint warnings.  
2. **Follows rmfw conventions** — naming, SoA layout, explicit imports.  
3. **No “possibly undefined” errors** — use non-null assertions where logically safe.  
4. **Deterministic behavior** — entity/DFS orders are stable and reproducible.  
5. **Meta-driven** — all schemas and components are self-describing.  
6. **Tests** cover both valid and invalid inputs, including round-trip checks.  
7. **Hover types are concise** — types aid developer understanding, not clutter it.  
8. **Output is drop-in ready** — can be pasted directly into the project tree.  
9. **Comments explain reasoning**, not just implementation.