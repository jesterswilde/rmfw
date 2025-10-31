// rmfw — Scene Loader (JSON v1, fully dynamic & meta-driven)
// • No hardcoded component lists; we ask world.store(block.name).
// • For each present row, write either provided column value or meta.default.
// • After hydration, auto-detect hierarchy stores and rebuild DFS orders.
// • Accepts optional root hints. For backward compat, supports both:
//      roots: Record<string, number[]>  (keyed by component name)
//   or  { transform: number[], render: number[] }  (legacy shape)

import { World } from "../ecs/core";
import { buildAllHierarchyTrees } from "./trees";

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

  const meta = store.meta as { fields: { key: string; default?: number; link?: boolean }[]; name: string };
  const cols = store.fields() as Record<string, Float32Array | Int32Array | Uint32Array>;

  // 1) Add components for all present entities (bounded by entityCount created by the caller)
  for (let i = 0; i < N; i++) if (block.present[i] === 1) { store.add(i); }

  // 2) Map provided columns by key (if any)
  const provided = new Map<string, number[]>();
  const order = block.fieldOrder ?? [];
  const columns = block.columns ?? [];
  for (let i = 0; i < order.length; i++) provided.set(order[i]!, columns[i]!);

  // 3) Hydrate with a single rolling counter over 'present' entities
  let row = 0;
  for (let e = 0; e < N; e++) if (block.present[e] === 1) {
    const dense = store.denseIndexOf(e);
    for (const f of meta.fields) {
      const column = cols[f.key] as any;
      if (!column) continue;
      const arr = provided.get(f.key);
      const value = arr ? arr[row]! : (f.default ?? 0);
      column[dense] = f.link ? (value | 0) : value;
    }
    row++;
  }
}

/** Normalize root hints: accept a name->array map, or {transform, render} legacy. */
function normalizeRoots(roots: RmfwSceneV1["roots"] | undefined): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!roots) return out;

  // Legacy shape support
  if ("transform" in roots || "render" in roots) {
    if ((roots as any).transform) out.set("TransformNode", (roots as any).transform!);
    if ((roots as any).render)    out.set("RenderNode",    (roots as any).render!);
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

  // 2) Apply all components dynamically
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
