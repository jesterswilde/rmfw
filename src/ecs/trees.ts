// src/ecs/trees.ts
//
// Phase 2: CPU-only tree wrappers for hierarchical components.
// - HierarchyTree works with any store that has { parent, firstChild, nextSibling } link fields.
// - buildAllHierarchyTrees(world) auto-detects such stores.
// - TransformTree adds reparent()/makeRoot() that preserve world transform.
// - RenderTree is a thin convenience wrapper.

import { World, type StoreOf } from "../ecs/core.js";
import { TransformMeta } from "./registry.js";
import {
  isOrthonormal3x3,
  inverseRigid3x4_into,
  inverseGeneral3x4_into,
  mulRigid3x4_into,
} from "./math.js";

const NONE = -1;

/** Explicit shape of the hierarchical node columns in a SoA store. */
interface NodeColumns {
  parent: Int32Array;      // -1 if root
  firstChild: Int32Array;  // head of singly-linked child list
  nextSibling: Int32Array; // next sibling in list
}

type NodeStore = StoreOf<any>;

export function isHierarchyStore(store: NodeStore): boolean {
  const m = (store as any).meta as { fields: { key: string; ctor: any; link?: boolean }[] } | undefined;
  if (!m || !Array.isArray(m.fields)) return false;

  const need = new Set(["parent", "firstChild", "nextSibling"]);
  let ok = 0;
  for (const f of m.fields) {
    if (!need.has(f.key)) continue;
    const isI32 = f.ctor === Int32Array;
    const isLink = !!f.link;
    if (isI32 && isLink) ok++;
  }
  return ok === 3;
}

/** Narrow untyped fields() to our explicit NodeColumns shape. */
function nodeColumns(store: NodeStore): NodeColumns {
  return store.fields() as unknown as NodeColumns;
}

/** Detach an entity from its current parent, if any. */
function detachFromParent(nodeStore: NodeStore, entityId: number) {
  const cols = nodeColumns(nodeStore);
  const denseIndex = nodeStore.denseIndexOf(entityId);
  if (denseIndex < 0) return;

  const parentEntityId = (cols.parent[denseIndex]!) | 0;
  if (parentEntityId === NONE) return;

  const parentDenseIndex = nodeStore.denseIndexOf(parentEntityId);
  if (parentDenseIndex < 0) return;

  let prev = NONE;
  let cur = (cols.firstChild[parentDenseIndex]!) | 0;

  while (cur !== NONE) {
    const curDense = nodeStore.denseIndexOf(cur)!;

    if (cur === entityId) {
      const next = (cols.nextSibling[curDense]!) | 0;
      if (prev === NONE) cols.firstChild[parentDenseIndex] = next;
      else cols.nextSibling[nodeStore.denseIndexOf(prev)!] = next;

      cols.parent[denseIndex] = NONE;
      cols.nextSibling[denseIndex] = NONE;
      return;
    }
    prev = cur;
    cur = (cols.nextSibling[curDense]!) | 0;
  }
}

/** Append child at the end of the parent's child list (stable order among siblings). */
function appendChildAtEnd(nodeStore: NodeStore, parentEntityId: number, childEntityId: number) {
  const cols = nodeColumns(nodeStore);
  const pRow = nodeStore.denseIndexOf(parentEntityId);
  const cRow = nodeStore.denseIndexOf(childEntityId);
  if (pRow < 0 || cRow < 0) throw new Error("appendChildAtEnd: missing node component(s)");

  let lastChild = (cols.firstChild[pRow]!) | 0;
  if (lastChild === NONE) {
    cols.firstChild[pRow] = childEntityId | 0;
  } else {
    while (true) {
      const lastRow = nodeStore.denseIndexOf(lastChild)!;
      const next = (cols.nextSibling[lastRow]!) | 0;
      if (next === NONE) { cols.nextSibling[lastRow] = childEntityId | 0; break; }
      lastChild = next;
    }
  }
  cols.parent[cRow] = parentEntityId | 0;
  cols.nextSibling[cRow] = NONE;
}

/** Compute a deterministic DFS order for the given hierarchy store. */
function computeDFSOrder(nodeStore: NodeStore, explicitRootEntityIds?: number[]): Int32Array {
  const cols = nodeColumns(nodeStore);
  const ordered: number[] = [];

  // Roots either explicitly provided or discovered via parent == -1
  const roots = new Set<number>();
  if (explicitRootEntityIds?.length) {
    for (const r of explicitRootEntityIds) roots.add(r);
  } else {
    const d2e = nodeStore.denseToEntity;
    for (let i = 0; i < nodeStore.size; i++) {
      const e = d2e[i]!;
      const row = nodeStore.denseIndexOf(e)!;
      if (((cols.parent[row]!) | 0) === NONE) roots.add(e);
    }
  }

  const sortedRoots = Array.from(roots).sort((a, b) => a - b);
  const stack: number[] = [];

  const pushChildren = (entityId: number) => {
    const row = nodeStore.denseIndexOf(entityId)!;
    const acc: number[] = [];
    let c = (cols.firstChild[row]!) | 0;
    while (c !== NONE) {
      acc.push(c);
      const cr = nodeStore.denseIndexOf(c)!;
      c = (cols.nextSibling[cr]!) | 0;
    }
    for (let i = acc.length - 1; i >= 0; i--) stack.push(acc[i]!);
  };

  for (let i = sortedRoots.length - 1; i >= 0; i--) stack.push(sortedRoots[i]!);
  while (stack.length) {
    const e = stack.pop()!;
    ordered.push(e);
    pushChildren(e);
  }

  return Int32Array.from(ordered);
}

/** Base class: stores DFS order + epoch and exposes rebuild hook. */
export class HierarchyTree {
  readonly componentName: string;
  protected world: World;
  protected nodeStore: NodeStore;
  protected _order: Int32Array = new Int32Array(0);
  protected _epoch = 0;

  constructor(world: World, nodeStore: NodeStore) {
    this.world = world;
    this.nodeStore = nodeStore;
    this.componentName = (nodeStore as any).name as string;
  }

  get order(): Int32Array { return this._order; }
  get epoch(): number { return this._epoch; }

  protected bump(entityHint?: number) {
    this._epoch++;
    if (entityHint != null && entityHint >= 0) {
      const id = entityHint | 0;
      if (id < this.world.entityEpoch.length)
        this.world.entityEpoch[id] = (this.world.entityEpoch[id]! + 1) >>> 0;
    }
  }

  rebuildOrder(explicitRoots?: number[]) {
    this._order = computeDFSOrder(this.nodeStore, explicitRoots);
    this._epoch++;
  }

  /** Ensure this entity has the node component (neutral defaults). */
  protected ensureNode(entityId: number) {
    if (!this.nodeStore.has(entityId)) {
      this.nodeStore.add(entityId, { parent: NONE, firstChild: NONE, nextSibling: NONE } as any);
    }
  }

  addChild(parent: number, child: number) {
    this.ensureNode(parent);
    this.ensureNode(child);
    detachFromParent(this.nodeStore, child);
    appendChildAtEnd(this.nodeStore, parent, child);
    this.bump(child);
    this.rebuildOrder();
  }

  /** Detach subtree root from parent (becomes a root). */
  remove(entity: number) {
    if (!this.nodeStore.has(entity)) return;
    detachFromParent(this.nodeStore, entity);
    this.bump(entity);
    this.rebuildOrder();
  }

  /**
   * Reparent while preserving world transform of `entity`.
   * local' = inverse(parentWorld_new) * world_current
   * Then mark entity's Transform dirty so propagate will refresh inverse and cascade.
   */
  reparent(entity: number, newParent: number) {
    if (entity === newParent) throw new Error("Cannot parent an entity to itself");
    this.ensureNode(entity);
    this.ensureNode(newParent);

    // Preserve world: local' = inv(parentWorld_new) * world(entity)
    const T = this.world.storeOf(TransformMeta);
    const tf = T.fields();

    // Parent world (identity if no Transform)
    let pr00 = 1, pr01 = 0, pr02 = 0, ptx = 0;
    let pr10 = 0, pr11 = 1, pr12 = 0, pty = 0;
    let pr20 = 0, pr21 = 0, pr22 = 1, ptz = 0;

    const parentTRow = T.denseIndexOf(newParent);
    if (parentTRow >= 0) {
      pr00 = tf.world_r00[parentTRow]!;
      pr01 = tf.world_r01[parentTRow]!;
      pr02 = tf.world_r02[parentTRow]!;
      ptx  = tf.world_tx [parentTRow]!;
      pr10 = tf.world_r10[parentTRow]!;
      pr11 = tf.world_r11[parentTRow]!;
      pr12 = tf.world_r12[parentTRow]!;
      pty  = tf.world_ty [parentTRow]!;
      pr20 = tf.world_r20[parentTRow]!;
      pr21 = tf.world_r21[parentTRow]!;
      pr22 = tf.world_r22[parentTRow]!;
      ptz  = tf.world_tz [parentTRow]!;
    }

    const invParent = new Float32Array(12);
    if (isOrthonormal3x3(pr00,pr01,pr02, pr10,pr11,pr12, pr20,pr21,pr22)) {
      inverseRigid3x4_into(pr00,pr01,pr02,ptx, pr10,pr11,pr12,pty, pr20,pr21,pr22,ptz, invParent);
    } else {
      inverseGeneral3x4_into(pr00,pr01,pr02,ptx, pr10,pr11,pr12,pty, pr20,pr21,pr22,ptz, invParent);
    }

    const eTRow = T.denseIndexOf(entity);
    if (eTRow >= 0) {
      const wr00 = tf.world_r00[eTRow]!, wr01 = tf.world_r01[eTRow]!, wr02 = tf.world_r02[eTRow]!, wtx = tf.world_tx[eTRow]!;
      const wr10 = tf.world_r10[eTRow]!, wr11 = tf.world_r11[eTRow]!, wr12 = tf.world_r12[eTRow]!, wty = tf.world_ty[eTRow]!;
      const wr20 = tf.world_r20[eTRow]!, wr21 = tf.world_r21[eTRow]!, wr22 = tf.world_r22[eTRow]!, wtz = tf.world_tz[eTRow]!;

      const localPrime = new Float32Array(12);
      mulRigid3x4_into(
        invParent[0]!, invParent[1]!, invParent[2]!, invParent[3]!,
        invParent[4]!, invParent[5]!, invParent[6]!, invParent[7]!,
        invParent[8]!, invParent[9]!, invParent[10]!, invParent[11]!,
        wr00,wr01,wr02,wtx, wr10,wr11,wr12,wty, wr20,wr21,wr22,wtz,
        localPrime
      );

      // Write new local
      tf.local_r00[eTRow] = localPrime[0]!;
      tf.local_r01[eTRow] = localPrime[1]!;
      tf.local_r02[eTRow] = localPrime[2]!;
      tf.local_tx [eTRow] = localPrime[3]!;
      tf.local_r10[eTRow] = localPrime[4]!;
      tf.local_r11[eTRow] = localPrime[5]!;
      tf.local_r12[eTRow] = localPrime[6]!;
      tf.local_ty [eTRow] = localPrime[7]!;
      tf.local_r20[eTRow] = localPrime[8]!;
      tf.local_r21[eTRow] = localPrime[9]!;
      tf.local_r22[eTRow] = localPrime[10]!;
      tf.local_tz [eTRow] = localPrime[11]!;
      tf.dirty[eTRow] = 1;
    }

    // Link change
    detachFromParent(this.nodeStore, entity);
    appendChildAtEnd(this.nodeStore, newParent, entity);

    this.bump(entity);
    this.rebuildOrder();
  }

  /** Make entity a root while preserving its world: local' = world(entity). */
  makeRoot(entity: number) {
    this.ensureNode(entity);

    const T = this.world.storeOf(TransformMeta);
    const tf = T.fields();
    const eTRow = T.denseIndexOf(entity);

    if (eTRow >= 0) {
      tf.local_r00[eTRow] = tf.world_r00[eTRow]!;
      tf.local_r01[eTRow] = tf.world_r01[eTRow]!;
      tf.local_r02[eTRow] = tf.world_r02[eTRow]!;
      tf.local_tx [eTRow] = tf.world_tx [eTRow]!;
      tf.local_r10[eTRow] = tf.world_r10[eTRow]!;
      tf.local_r11[eTRow] = tf.world_r11[eTRow]!;
      tf.local_r12[eTRow] = tf.world_r12[eTRow]!;
      tf.local_ty [eTRow] = tf.world_ty [eTRow]!;
      tf.local_r20[eTRow] = tf.world_r20[eTRow]!;
      tf.local_r21[eTRow] = tf.world_r21[eTRow]!;
      tf.local_r22[eTRow] = tf.world_r22[eTRow]!;
      tf.local_tz [eTRow] = tf.world_tz [eTRow]!;
      tf.dirty[eTRow] = 1;
    }

    // Detach from hierarchy
    detachFromParent(this.nodeStore, entity);

    this.bump(entity);
    this.rebuildOrder();
  }
}

/** Auto-detect all hierarchy component stores and return trees keyed by component name. */
export function buildAllHierarchyTrees(world: World): Map<string, HierarchyTree> {
  const trees = new Map<string, HierarchyTree>();
  const worldAny = world as any;

  // Prefer internal helpers if present.
  const names: string[] =
    typeof worldAny.__listStoreNames === "function"
      ? (worldAny.__listStoreNames() as string[])
      : ["TransformNode", "RenderNode"]; // fallback guesses (safe to ignore if not found)

  const seen = new Set<string>();
  for (const n of names) {
    try {
      const store = world.store(n);
      if (isHierarchyStore(store)) {
        trees.set(n, new HierarchyTree(world, store));
        seen.add(n);
      }
    } catch { /* ignore unknown */ }
  }

  if (typeof worldAny.__forEachStore === "function") {
    worldAny.__forEachStore((name: string, store: NodeStore) => {
      if (!seen.has(name) && isHierarchyStore(store)) {
        trees.set(name, new HierarchyTree(world, store));
      }
    });
  }

  return trees;
}

/** Optional convenience wrappers for legacy callsites. */
export class TransformTree extends HierarchyTree {
  constructor(world: World) { super(world, world.store("TransformNode")); }
}
export class RenderTree extends HierarchyTree {
  constructor(world: World) { super(world, world.store("RenderNode")); }
}
