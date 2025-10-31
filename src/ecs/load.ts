// src/ecs/load.ts
// rmfw — Scene Loader (JSON v1, fully dynamic & meta-driven)

import { World } from "../ecs/core.js";
import { buildAllHierarchyTrees } from "./trees.js";

const NONE = -1;

export interface RmfwComponentBlockV1 {
  name: string;
  present: number[];
  fieldOrder?: string[];
  columns?: number[][];
}

export interface RmfwSceneV1 {
  version: 1;
  project: "rmfw";
  entityCount: number;
  components: RmfwComponentBlockV1[];
  // Either a map of componentName -> roots, or legacy {transform, render}
  roots?: Record<string, number[]> | { transform?: number[]; render?: number[] };
}

function applyComponentBlock(world: World, block: RmfwComponentBlockV1) {
  const N = block.present.length | 0;

  // Obtain store dynamically by component name; unknown components are ignored.
  let store: any;
  try {
    store = world.store(block.name);
  } catch {
    return; // unknown component; skip
  }

  const meta = store.meta as {
    fields: { key: string; default?: number; link?: boolean }[];
    name: string;
  };

  // ---- 1) Ensure rows exist for all present entities.
  // (Do this *before* retrieving column views so any growth happens first.)
  for (let i = 0; i < N; i++) {
    if (block.present[i] === 1) {
      store.add(i);
    }
  }

  // ---- Re-fetch columns *after* potential growth so we write into live arrays.
  const cols = store.fields() as Record<
    string,
    Float32Array | Int32Array | Uint32Array
  >;

  // ---- 2) Map provided columns by key (if any).
  const provided = new Map<string, number[]>();
  const order = block.fieldOrder ?? [];
  const columns = block.columns ?? [];
  for (let i = 0; i < order.length; i++) {
    // tolerate malformed payloads (excess keys/columns)
    const key = order[i]!;
    const arr = columns[i];
    if (arr) provided.set(key, arr);
  }

  // ---- 3) Hydrate rows in a single pass over 'present' entities.
  let row = 0; // index into each provided column (counts only present==1)
  for (let e = 0; e < N; e++) {
    if (block.present[e] !== 1) continue;

    const dense = store.denseIndexOf(e);
    // Defensive check: if something went wrong with add/lookup, skip this entity
    if (dense < 0) {
      row++;
      continue;
    }

    for (const f of meta.fields) {
      const column = cols[f.key] as any;
      if (!column) continue; // tolerate missing columns

      const arr = provided.get(f.key);
      const value = arr !== undefined ? arr[row]! : (f.default ?? 0);

      // Links are integer-valued; other fields may be float.
      column[dense] = f.link ? (value | 0) : value;
    }

    row++;
  }
}

/** Normalize root hints: accept a name->array map, or {transform, render} legacy. */
function normalizeRoots(
  roots: RmfwSceneV1["roots"] | undefined
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!roots) return out;

  // Legacy shape support
  if (
    typeof roots === "object" &&
    (Object.prototype.hasOwnProperty.call(roots, "transform") ||
      Object.prototype.hasOwnProperty.call(roots, "render"))
  ) {
    const legacy = roots as any;
    if (legacy.transform) out.set("TransformNode", legacy.transform as number[]);
    if (legacy.render) out.set("RenderNode", legacy.render as number[]);
    return out;
  }

  // Map<string, number[]>
  for (const k of Object.keys(roots)) out.set(k, (roots as any)[k]!);
  return out;
}

export function loadScene(world: World, scene: RmfwSceneV1) {
  if (scene.version !== 1 || scene.project !== "rmfw") {
    throw new Error("Unsupported scene format");
  }

  const N = scene.entityCount | 0;

  // 1) Create N dense entities [0..N-1]
  for (let i = 0; i < N; i++) world.createEntity();

  // 2) Apply all components dynamically (meta-driven)
  for (const block of scene.components) applyComponentBlock(world, block);

  // 3) Auto-detect and rebuild DFS orders for all hierarchy stores.
  const rootHints = normalizeRoots(scene.roots);
  const trees = buildAllHierarchyTrees(world);
  for (const [name, tree] of trees) {
    const hints = rootHints.get(name);
    tree.rebuildOrder(hints);
  }

  return { entityCount: N, trees };
}
