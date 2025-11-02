// rmfw — Scene Saver JSON v1
import { World } from "./core/index.js";
import { Transform, TransformNode, RenderNode, ShapeLeaf, Operation } from "./registry.js";

const NONE = -1;

const isLinkField = (f: { readonly key: string; readonly link?: boolean }): boolean =>
  f.link === true;


export interface RmfwComponentBlockV1 {
  name: string;
  present: number[];        // length = entityCount (0/1)
  fieldOrder?: string[];    // optional; aligns with columns
  columns?: number[][];     // compact, length = count(present==1)
}

export interface RmfwSceneV1 {
  version: 1;
  project: "rmfw";
  entityCount: number;
  components: RmfwComponentBlockV1[];
  roots?: { transform?: number[]; render?: number[] };
}

const ALL_COMPONENTS = [
  Transform.meta,
  TransformNode.meta,
  RenderNode.meta,
  ShapeLeaf.meta,
  Operation.meta,
];

function liveEntitiesDense(world: World): number[] {
  // deterministic asc entity id
  return world.entities.dense.slice().sort((a, b) => a - b);
}

function makeRemap(live: number[]) {
  const m = new Map<number, number>();
  live.forEach((e, i) => m.set(e, i));
  return (oldId: number) => (oldId === NONE ? NONE : (m.get(oldId) ?? -1));
}

/** Collect one component into {present, fieldOrder, columns} following meta order. */
function collectComponentBlock(
  world: World,
  meta: (typeof ALL_COMPONENTS)[number],
  entityOrder: number[],
  remapId: (n: number) => number,
  opts?: { dropDefaultColumns?: boolean }
): RmfwComponentBlockV1 | null {
  let store: ReturnType<World["store"]>;
  try {
    store = world.store(meta.name);
  } catch {
    return null;
  }
  const fields = store.fields() as Record<string, Float32Array | Int32Array | Uint32Array>;

  const present = new Array<number>(entityOrder.length).fill(0);
  const denseRows: number[] = [];

  for (let i = 0; i < entityOrder.length; i++) {
    const e = entityOrder[i]!;
    if (store.has(e)) { present[i] = 1; denseRows.push(store.denseIndexOf(e)); }
  }
  if (denseRows.length === 0) return null;

  const fieldOrder: string[] = [];
  const columns: number[][] = [];

  for (const f of meta.fields) {
    const col = fields[f.key];
    if (!col) 
        continue; // tolerate missing column
    const out = new Array<number>(denseRows.length);

    if (isLinkField(f)) {
      for (let j = 0; j < denseRows.length; j++) {
        const v = (col as any)[denseRows[j]!] | 0;
        out[j] = v === NONE ? NONE : remapId(v);
      }
    } else {
      for (let j = 0; j < denseRows.length; j++) out[j] = Number((col as any)[denseRows[j]!]);
    }

    // Optional: drop all-default columns to shrink JSON
    if (opts?.dropDefaultColumns) {
      let allDef = true;
      const def = f.default ?? 0;
      for (let k = 0; k < out.length; k++) { if (out[k] !== def) { 
        allDef = false; break; } }
      if (allDef) 
        continue;
    }

    fieldOrder.push(f.key);
    columns.push(out);
  }

  // If every column was all-default and dropped, we still keep present mask only.
  const block: RmfwComponentBlockV1 = { name: meta.name, present };
  if (fieldOrder.length) { block.fieldOrder = fieldOrder; block.columns = columns; }
  return block;
}

export function saveScene(
  world: World,
  opts?: { dropDefaultColumns?: boolean; includeRoots?: boolean }
): RmfwSceneV1 {
  const live = liveEntitiesDense(world);
  const remap = makeRemap(live);

  const components: RmfwComponentBlockV1[] = [];
  for (const meta of ALL_COMPONENTS) {
    const blk = collectComponentBlock(world, meta, live, remap, { dropDefaultColumns: !!opts?.dropDefaultColumns });
    if (blk) components.push(blk);
  }

  const scene: RmfwSceneV1 = {
    version: 1,
    project: "rmfw",
    entityCount: live.length,
    components,
  };

  if (opts?.includeRoots) {
    const tn = components.find(c => c.name === TransformNode.meta.name);
    const rn = components.find(c => c.name === RenderNode.meta.name);
    const roots = { transform: [] as number[], render: [] as number[] };

    if (tn?.fieldOrder && tn.columns) {
      const pIdx = tn.fieldOrder.indexOf("parent");
      if (pIdx >= 0) {
        let k = 0;
        for (let i = 0; i < tn.present.length; i++) if (tn.present[i] === 1) {
          if (tn.columns[pIdx]![k++] === NONE) roots.transform.push(i);
        }
      }
    }
    if (rn?.fieldOrder && rn.columns) {
      const pIdx = rn.fieldOrder.indexOf("parent");
      if (pIdx >= 0) {
        let k = 0;
        for (let i = 0; i < rn.present.length; i++) if (rn.present[i] === 1) {
          if (rn.columns[pIdx]![k++] === NONE) roots.render.push(i);
        }
      }
    }
    scene.roots = roots;
  }

  return scene;
}
