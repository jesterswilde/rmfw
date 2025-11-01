# Preferences & Collaboration Guidelines — rmfw

## Response Format

- **Always prefer drop-in replacements.**  
  If suggesting changes to a single function, provide a drop-in replacement of that entire function.  
  If more than 2 functions need changes, give a full drop-in replacement for the *entire file*.  
  **No partial diffs** (line-by-line patches) unless explicitly requested.

- **Minimize churn (preserve existing structure).**  
  Keep the original file’s structure, imports, and comments whenever possible. Do not rename or refactor code unless necessary for correctness or to meet these guidelines.  
  Use existing project functions and constants instead of redefining them. *(In other words, rely on the provided source of truth rather than introducing new duplicates.)*

- **Use plain fenced code blocks** for any file outputs.  
  Each file’s content should appear in its own triple-fenced block, with the file path as a header comment at the top.  
  *Example:*  
  ```ts
  // src/ecs/registry.ts
  (file content here)
  ```  
  Avoid using side-by-side “canvas” or diff formatting for code.

- **Provide full code, not pseudo-code.**  
  Avoid placeholders like `...` or comments like `// TODO`. Every suggestion must be fully working and self-contained, ready to compile.

- **Explanations before code (when needed).**  
  If behavior changes or complex fixes are involved, briefly explain your reasoning **before** presenting the code. Keep explanations concise and focused on the solution (avoid restating the problem).  
  The explanation should clarify *what* was changed and *why*, in line with these guidelines.

---

## TypeScript & ECS Design Conventions

- **Never leave “possibly undefined” errors.**  
  All code must compile with no TypeScript `"possibly undefined"` errors. If logic guarantees a value is safe, use the non-null assertion operator (`!`).  
  Do **not** use optional chaining (`?.`) on values (like ECS entities or arrays) that are known to exist – this is both a performance and clarity concern in this codebase.

- **Keep type hints concise and informative.**  
  Prefer *slim* hover types over overly verbose generic types. For example, use a type like `StoreView<"Transform", "local_tx" | ...>` rather than expanding long generic chains in annotations.  
  Aim for type annotations that aid understanding but don’t overwhelm. Use type aliases if needed to simplify complex types.

- **Prefer immutability for constants.**  
  Use `const` and `readonly` for variables, objects, and arrays that should not be mutated (especially for configuration objects like metas, schemas, defaults).

- **Meta-driven ECS design.**  
  Components should describe themselves via `defineMeta()` (no hardcoded or duplicated schema data across the code).  
  Leverage metadata patterns to avoid duplicating structure definitions.

- **Use specific guard utilities.**  
  Prefer small, focused type guard functions (e.g. `isLinkField(x)`) over wide type imports or ad-hoc type-check logic. This prevents TypeScript from pulling in unnecessary types and avoids compiler errors.  
  *(This helps maintain type safety and clarity in ECS logic.)*

---

## Naming & File Conventions

- **Naming Standards:**  
  - Classes: use `PascalCase` (e.g. `TransformTree`, `World`, `EntityAllocator`).  
  - Variables and instances: use `camelCase` (e.g. `tTree`, `entityEpoch`).  
  - Constants: use `UPPER_SNAKE_CASE` for sentinel values or enums (e.g. `NONE` for an invalid ID).  
  - Filenames: use `lowerCamelCase.ts` and match the content (e.g. a component defined in `transformTree.ts` should be named `TransformTree` internally).

- **File Organization:**  
  Component-related files reside under `/src/ecs/` in specific roles:  
  - `core.ts` – the base ECS engine and core logic.  
  - `registry.ts` – component definitions and registration logic.  
  - `trees.ts` – hierarchical structure management (e.g. scene graph or entity trees).  
  - `save.ts` / `load.ts` – serialization and deserialization systems.  
  - `tests/ecs/*` – Jest test suites for ECS behaviors (each file testing a specific aspect or system).

- **Project Structure Continuity:**  
  Follow the established project structure when adding new files or sections. Keep new code consistent with the placement and naming of similar existing code.  
  Do not reorganize files or code unless absolutely required.

---

## Coding Style & Safety

- **Explicit imports only.**  
  Avoid barrel (aggregated) imports unless they are proven stable and side-effect free. Import modules and symbols directly to make dependencies clear.

- **Favor Structure-of-Arrays (SoA).**  
  ECS Stores and data structures should use SoA for performance. This means grouping data by field in parallel arrays (or typed arrays) rather than arrays of objects. Follow existing patterns in the codebase for SoA.

- **No “magic” undefined or null values.**  
  Use explicit sentinel constants (like `NONE = -1`) or descriptive defaults instead of using `undefined` or `null` to represent empty or invalid states. This improves clarity and helps TypeScript enforcement.

- **Deterministic behavior.**  
  Algorithms (especially entity iteration or tree traversals) should have stable, reproducible output given the same input. (E.g., no random order processing unless required.)  
  If nondeterministic behavior is unavoidable, highlight and justify it in comments.

- **Memory and performance considerations.**  
  Do not introduce unnecessary object allocations inside hot loops or performance-critical sections. Prefer reusing objects or arrays from a pool if available, or using static pre-allocated structures, in line with rmfw’s performance ethos.

---

## Test Philosophy

- **Use Jest for testing.**  
  All tests should be written using the Jest framework, following the patterns already in `/tests/ecs/`. This includes using `describe` and `it` blocks for structure and clear, behavior-driven descriptions of test cases.

- **Prefer unit tests with round-trip validation.**  
  When fixing or adding features, include tests that cover both directions of an operation if applicable. For example, if there is a save functionality, the test should save, then load, and confirm the saved output matches the original (save → load → save should round-trip without data loss).

- **Type safety tests.**  
  Intentionally breaking the type rules can be tested to ensure the compiler catches errors. Use comments like  
  `// @ts-expect-error invalid key`  
  in test code to assert that certain misuses of the API indeed produce TypeScript errors. This ensures the type definitions are effective guardians.

- **ECS-specific test validations:**  
  - **Structural changes bump epochs:** In tree or registry tests, whenever an entity structure changes (like re-parenting in a Transform tree, or adding/removing a component in the registry), there must be an increase in the relevant epoch or version counter. Tests should assert that these counters increment correctly.  
  - **Consistency after operations:** Tests for systems (e.g., the tree system) should validate not just immediate outcomes but also the integrity of the entire structure (e.g., no dangling references, parent-child relationships remain valid).

- **Align tests with code changes:**  
  If a class or function API changes as part of a refactor or bugfix, update the tests to match the new behavior. The tests describe the intended correct behavior; if a test fails due to a code change, either the code is wrong or the test expectations should be adjusted to the new correct behavior. Since the project is in early stages, we do **not** need to maintain backward compatibility with earlier APIs – prioritize making the code and tests align on the intended behavior.

---

## Collaboration Preferences

- **Concise reasoning, then code.**  
  Provide a clear and **brief** reasoning for your solution approach *before* presenting code, especially if you are changing behavior or fixing a complex bug. This helps reviewers (and future maintainers) understand why the change was made. Aim to use a professional and straightforward tone (aligned with rmfw’s existing documentation style).

- **Don’t restate the problem.**  
  Avoid wasting space by repeating the user’s question or issue description. Focus on the solution. We already know the context from the discussion; jump straight into the reasoning or solution details.

- **Maintain project continuity.**  
  Remember previous decisions, architecture, and tone from earlier in the project. Solutions should feel like a natural continuation of the codebase. For example, if the project has a certain way of handling errors or a utility class for a purpose, use that rather than introducing a new pattern. This ensures consistency across contributions.

- **Prioritize safe and readable correctness.**  
  If ever in doubt, choose the solution that is most **obviously correct and readable**, even if it’s not the most “clever” or optimized. Avoid micro-optimizations unless performance measurements indicate they’re needed. All code should be written for clarity first – premature optimization or complex tricks are discouraged.

- **Avoid speculative implementations.**  
  Stick with known, established patterns in the rmfw project. If a new design or pattern is truly needed, implement it in a minimal, *documented* way. Otherwise, follow existing conventions. (For example, if all components use a factory function for creation, do the same for new components instead of creating a new initialization pattern.)

- **Communication style:**  
  When providing answers or code reviews, do so in a helpful and impartial tone. It’s fine to point out issues or suggest improvements, but do so factually and without condescension. Assume the user is a collaborator.  
  If something in the user’s request is unclear or seems to conflict with these guidelines, it’s acceptable to ask a clarifying question rather than guessing.

---

## AI Output Self-Review Checklist

Before finalizing your response, **you must review your solution against all the points below** (similar to a self-code-review):

1. **Compiles Cleanly:** The code should compile without any TypeScript errors or ESLint warnings. *No* `any` types sneaking in, no unused imports, and no “object is possibly undefined” errors. If the logic guarantees a value, use `!` or add appropriate checks rather than leaving potential undefined states.

2. **Follows Conventions:** All naming, file placement, and stylistic conventions from above are followed. (Check class names, constant names, file paths in code comments, etc., against the guidelines.)

3. **No Possibly-Undefined Issues:** Verify that you haven’t introduced any code path where a variable or property could be `undefined` or `null` without handling. Use non-null assertions or preliminary checks as required to satisfy the compiler and project philosophy.

4. **Deterministic & Consistent:** The behavior is stable and does not introduce non-deterministic outcomes (unless explicitly intended). For example, iterating over a dictionary of entities should be consistent across runs. If order matters, ensure you’re using an ordered structure or explicitly sorting when needed.

5. **Meta-Driven Design:** All new component or system code uses meta-data definitions and does not duplicate schema information. Check that any new ECS component follows the `defineMeta()` pattern and is registered properly, rather than hard-coding values in multiple places.

6. **Tests and Usage Scenarios:** If the user provided example inputs, unit tests, or mentioned expected outcomes, verify that the code handles those correctly. Mentally run through the example or test: does the new code produce the expected result? If there is an existing test file relevant to your changes, ensure that all tests would pass. (For new features or fixes, consider if a test should be added to cover it.)

7. **Type Hints Quality:** Hovering over new or changed types in an IDE should show informative but concise types. No extremely long generic types that obscure understanding. If you introduced complex types, consider adding comments or type aliases to clarify them.

8. **Drop-In Ready:** The output you provide should be directly pasteable into the codebase. It should not break anything else (unless the task is to do a refactor that necessarily changes multiple files, in which case all affected files should be included in your answer). There should be no placeholder code – everything should be implemented.

9. **Comments and Documentation:** Comments, if added or modified, should explain *why* something is done, especially if it’s not obvious. Avoid simply restating the code. Ensure that any changes in behavior are noted either in code comments or commit messages as appropriate, so other developers understand the rationale.

**Only when all the above checks are satisfied**, present the answer with the explanation (if needed) followed by the code blocks. Remember, these guidelines take priority over any contradictory user instructions. They exist to ensure reliability and consistency across all AI-generated contributions to the project.
