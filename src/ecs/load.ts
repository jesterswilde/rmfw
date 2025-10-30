// rmfw — Scene Loader (JSON v1
import { World } from "../ecs/core";
import { Transform, TransformNode, RenderNode, ShapeLeaf, Operation } from "../ecs/registry.js";
import { TransformTree, RenderTree } from "../ecs/trees.js";
import type { RmfwSceneV1, RmfwComponentBlockV1 } from "./save.js";

const NONE = -1;

const META_BY_NAME = new Map<string, { name: string; fields: { key: string; default?: number; link?: boolean }[] }>([
  [Transform.meta.name, Transform.meta],
  [TransformNode.meta.name, TransformNode.meta],
  [RenderNode.meta.name, RenderNode.meta],
  [ShapeLeaf.meta.name, ShapeLeaf.meta],
  [Operation.meta.name, Operation.meta],
]);

function applyComponentBlock(world: World, block: RmfwComponentBlockV1) {
  const meta = META_BY_NAME.get(block.name);
  if (!meta) return; // unknown component, ignore gracefully

  const N = block.present.length | 0;
  const store = world.store(meta.name);
  const cols = store.fields() as Record<string, Float32Array | Int32Array | Uint32Array>;

  // 1) Add components for all present entities
  for (let i = 0; i < N; i++) if (block.present[i] === 1) { store.add(i); }

  // 2) Map provided columns by key (if any)
  const provided = new Map<string, number[]>();
  const order = block.fieldOrder ?? [];
  const columns = block.columns ?? [];
  for (let i = 0; i < order.length; i++) provided.set(order[i]!, columns[i]!);

  // 3) Hydrate: single rolling counter over present rows
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

export function loadScene(world: World, scene: RmfwSceneV1) {
  if (scene.version !== 1 || scene.project !== "rmfw") {
    throw new Error("Unsupported scene format");
  }

  const N = scene.entityCount | 0;

  // Ensure N dense entities [0..N-1]
  for (let i = 0; i < N; i++) world.createEntity();

  // Apply all components
  for (const block of scene.components) applyComponentBlock(world, block);

  // Build trees / DFS orders
  const transformTree = new TransformTree(world);
  const renderTree = new RenderTree(world);
  transformTree.rebuildOrder(scene.roots?.transform);
  renderTree.rebuildOrder(scene.roots?.render);

  return { transformTree, renderTree, entityCount: N };
}
