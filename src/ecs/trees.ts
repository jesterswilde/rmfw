// src/ecs/trees.ts

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
  lastChild: Int32Array;   // tail of singly-linked child list (O(1) append)
  nextSibling: Int32Array; // next sibling in list
  prevSibling: Int32Array; // previous sibling in list (O(1) unlink)
}

type NodeStore = StoreOf<any>;

export function isHierarchyStore(store: NodeStore): boolean {
  const m = (store as any).meta as
    | { fields: { key: string; ctor: any; link?: boolean }[] }
    | undefined;
  if (!m || !Array.isArray(m.fields)) return false;

  // Require all five links in the Phase-2 schema.
  const need = new Set([
    "parent",
    "firstChild",
    "lastChild",
    "nextSibling",
    "prevSibling",
  ]);
  let ok = 0;
  for (const f of m.fields) {
    if (!need.has(f.key)) continue;
    const isI32 = f.ctor === Int32Array;
    const isLink = !!f.link;
    if (isI32 && isLink) ok++;
  }
  return ok === need.size;
}

/** Narrow untyped fields() to our explicit NodeColumns shape. */
function nodeColumns(store: NodeStore): NodeColumns {
  return store.fields() as unknown as NodeColumns;
}

/** Returns true if maybeAncestor is (strict) ancestor of node. No Sets; bounded hops + tortoise/hare. */
function isAncestor(
  nodeStore: NodeStore,
  maybeAncestor: number,
  node: number
): boolean {
  if (maybeAncestor === node || maybeAncestor === NONE || node === NONE)
    return false;

  const cols = nodeStore.fields() as any;
  let slow = node,
    fast = node;
  // Cap hops to avoid degenerate loops: at most `nodeStore.size` steps
  for (let hops = 0; hops < nodeStore.size; hops++) {
    // move slow by 1 parent
    const sRow = nodeStore.denseIndexOf(slow);
    if (sRow < 0) return false;
    slow = cols.parent[sRow] | 0;
    if (slow === maybeAncestor) return true;
    if (slow === NONE) return false;

    // move fast by 2 parents
    for (let k = 0; k < 2; k++) {
      const fRow = nodeStore.denseIndexOf(fast);
      if (fRow < 0) return false;
      fast = cols.parent[fRow] | 0;
      if (fast === maybeAncestor) return true;
      if (fast === NONE) return false;
    }
    // Cycle detection
    if (slow === fast) return false; // corrupted loop; treat as not ancestor to be safe
  }
  return false; // exceeded budget; assume not ancestor
}

/** detach from current parent/sibling list, if any. */
function detachFromParent(nodeStore: NodeStore, entityId: number) {
  const cols = nodeColumns(nodeStore);
  const row = nodeStore.denseIndexOf(entityId);
  if (row < 0) return;

  const parent = cols.parent[row]! | 0;
  if (parent === NONE) return;

  const parentRow = nodeStore.denseIndexOf(parent);
  if (parentRow < 0) return;

  const prev = cols.prevSibling[row]! | 0;
  const next = cols.nextSibling[row]! | 0;

  if (prev === NONE) {
    // removing head
    cols.firstChild[parentRow] = next;
  } else {
    const prevRow = nodeStore.denseIndexOf(prev)!;
    cols.nextSibling[prevRow] = next;
  }

  if (next === NONE) {
    // removing tail
    cols.lastChild[parentRow] = prev;
  } else {
    const nextRow = nodeStore.denseIndexOf(next)!;
    cols.prevSibling[nextRow] = prev;
  }

  cols.parent[row] = NONE;
  cols.prevSibling[row] = NONE;
  cols.nextSibling[row] = NONE;
}

/** append child at end  */
function appendChildAtEnd(
  nodeStore: NodeStore,
  parentEntityId: number,
  childEntityId: number
) {
  const cols = nodeColumns(nodeStore);
  const pRow = nodeStore.denseIndexOf(parentEntityId);
  const cRow = nodeStore.denseIndexOf(childEntityId);
  if (pRow < 0 || cRow < 0)
    throw new Error("appendChildAtEnd: missing node component(s)");

  const tail = cols.lastChild[pRow]! | 0;
  if (tail === NONE) {
    // first child
    cols.firstChild[pRow] = childEntityId | 0;
    cols.lastChild[pRow] = childEntityId | 0;
    cols.prevSibling[cRow] = NONE;
    cols.nextSibling[cRow] = NONE;
  } else {
    const tailRow = nodeStore.denseIndexOf(tail)!;
    cols.nextSibling[tailRow] = childEntityId | 0;
    cols.prevSibling[cRow] = tail | 0;
    cols.nextSibling[cRow] = NONE;
    cols.lastChild[pRow] = childEntityId | 0;
  }
  cols.parent[cRow] = parentEntityId | 0;
}

/** Compute a deterministic DFS order for the given hierarchy store.  */
function computeDFSOrder(
  nodeStore: NodeStore,
  explicitRootEntityIds?: number[]
): Int32Array {
  const cols = nodeColumns(nodeStore);
  const ordered: number[] = [];

  // 1) Collect roots deterministically.
  const roots: number[] = [];
  if (explicitRootEntityIds && explicitRootEntityIds.length > 0) {
    for (let i = 0; i < explicitRootEntityIds.length; i++) {
      const e = explicitRootEntityIds[i]! | 0;
      if (e >= 0 && nodeStore.has(e)) roots.push(e);
    }
  } else {
    const d2e = nodeStore.denseToEntity;
    for (let i = 0; i < nodeStore.size; i++) {
      const e = d2e[i]!;
      const row = nodeStore.denseIndexOf(e)!;
      if ((cols.parent[row]! | 0) === NONE) roots.push(e);
    }
  }
  roots.sort((a, b) => a - b);

  // 2) Single stack + isPopping enter/leave walk.
  //    Start with a modest capacity and grow as needed.
  let stack = new Int32Array(Math.max(64, roots.length | 0));
  const ensure = (needTop: number) => {
    if (needTop < stack.length) return;
    let n = stack.length;
    while (n <= needTop) n = Math.max(2, n << 1);
    const next = new Int32Array(n);
    next.set(stack);
    stack = next;
  };

  // Global safety bound: generous multiple of node count.
  const MAX_STEPS = (nodeStore.size | 0) * 4 + 16;

  for (let r = 0; r < roots.length; r++) {
    let top = 0;
    ensure(top);
    stack[top] = roots[r]!;

    let isPopping = false;
    let steps = 0;

    while (top >= 0 && steps++ <= MAX_STEPS) {
      const e = stack[top]!;
      const row = nodeStore.denseIndexOf(e);
      if (row < 0) {
        // Missing row → treat as a popped node.
        top--;
        isPopping = true;
        continue;
      }

      if (!isPopping) {
        // ENTER node
        ordered.push(e);

        // Descend to first child if present.
        const fc = cols.firstChild[row]! | 0;
        if (fc !== NONE) {
          const nextTop = top + 1;
          ensure(nextTop);
          stack[nextTop] = fc;
          top = nextTop;
          // continue ENTER on child
          isPopping = false;
          continue;
        }

        // Leaf: switch to LEAVE state
        isPopping = true;
        continue;
      }

      // LEAVE node: try sibling at same depth
      const sib = cols.nextSibling[row]! | 0;
      if (sib !== NONE) {
        stack[top] = sib;
        isPopping = false; // will ENTER sibling next
        continue;
      }

      // No sibling → POP
      top--;
      // remain in LEAVE state (parent will see its sibling or pop)
    }
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
    this.world.registerHierarchy(this.componentName, {
      remove: (e: number) => this.remove(e),
      componentName: this.componentName,
    });
  }

  get order(): Int32Array {
    return this._order;
  }
  get epoch(): number {
    return this._epoch;
  }

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
      this.nodeStore.add(entityId, {
        parent: NONE,
        firstChild: NONE,
        lastChild: NONE,
        nextSibling: NONE,
        prevSibling: NONE,
      } as any);
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
    if (entity === newParent)
      throw new Error("Cannot parent an entity to itself");
    this.ensureNode(entity);
    this.ensureNode(newParent);

    if (isAncestor(this.nodeStore, entity, newParent)) {
      throw new Error(
        "Cannot reparent: target parent is a descendant of the entity"
      );
    }

    // Preserve world: local' = inv(parentWorld_new) * world(entity)
    const T = this.world.storeOf(TransformMeta);
    const tf = T.fields();

    // Parent world (identity if no Transform)
    let pr00 = 1,
      pr01 = 0,
      pr02 = 0,
      ptx = 0;
    let pr10 = 0,
      pr11 = 1,
      pr12 = 0,
      pty = 0;
    let pr20 = 0,
      pr21 = 0,
      pr22 = 1,
      ptz = 0;

    const parentTRow = T.denseIndexOf(newParent);
    if (parentTRow >= 0) {
      pr00 = tf.world_r00[parentTRow]!;
      pr01 = tf.world_r01[parentTRow]!;
      pr02 = tf.world_r02[parentTRow]!;
      ptx = tf.world_tx[parentTRow]!;
      pr10 = tf.world_r10[parentTRow]!;
      pr11 = tf.world_r11[parentTRow]!;
      pr12 = tf.world_r12[parentTRow]!;
      pty = tf.world_ty[parentTRow]!;
      pr20 = tf.world_r20[parentTRow]!;
      pr21 = tf.world_r21[parentTRow]!;
      pr22 = tf.world_r22[parentTRow]!;
      ptz = tf.world_tz[parentTRow]!;
    }

    const invParent = new Float32Array(12);
    if (
      isOrthonormal3x3(pr00, pr01, pr02, pr10, pr11, pr12, pr20, pr21, pr22)
    ) {
      inverseRigid3x4_into(
        pr00,
        pr01,
        pr02,
        ptx,
        pr10,
        pr11,
        pr12,
        pty,
        pr20,
        pr21,
        pr22,
        ptz,
        invParent
      );
    } else {
      inverseGeneral3x4_into(
        pr00,
        pr01,
        pr02,
        ptx,
        pr10,
        pr11,
        pr12,
        pty,
        pr20,
        pr21,
        pr22,
        ptz,
        invParent
      );
    }

    const eTRow = T.denseIndexOf(entity);
    if (eTRow >= 0) {
      const wr00 = tf.world_r00[eTRow]!,
        wr01 = tf.world_r01[eTRow]!,
        wr02 = tf.world_r02[eTRow]!,
        wtx = tf.world_tx[eTRow]!;
      const wr10 = tf.world_r10[eTRow]!,
        wr11 = tf.world_r11[eTRow]!,
        wr12 = tf.world_r12[eTRow]!,
        wty = tf.world_ty[eTRow]!;
      const wr20 = tf.world_r20[eTRow]!,
        wr21 = tf.world_r21[eTRow]!,
        wr22 = tf.world_r22[eTRow]!,
        wtz = tf.world_tz[eTRow]!;

      const localPrime = new Float32Array(12);
      mulRigid3x4_into(
        invParent[0]!,
        invParent[1]!,
        invParent[2]!,
        invParent[3]!,
        invParent[4]!,
        invParent[5]!,
        invParent[6]!,
        invParent[7]!,
        invParent[8]!,
        invParent[9]!,
        invParent[10]!,
        invParent[11]!,
        wr00,
        wr01,
        wr02,
        wtx,
        wr10,
        wr11,
        wr12,
        wty,
        wr20,
        wr21,
        wr22,
        wtz,
        localPrime
      );

      // Write new local
      tf.local_r00[eTRow] = localPrime[0]!;
      tf.local_r01[eTRow] = localPrime[1]!;
      tf.local_r02[eTRow] = localPrime[2]!;
      tf.local_tx[eTRow] = localPrime[3]!;
      tf.local_r10[eTRow] = localPrime[4]!;
      tf.local_r11[eTRow] = localPrime[5]!;
      tf.local_r12[eTRow] = localPrime[6]!;
      tf.local_ty[eTRow] = localPrime[7]!;
      tf.local_r20[eTRow] = localPrime[8]!;
      tf.local_r21[eTRow] = localPrime[9]!;
      tf.local_r22[eTRow] = localPrime[10]!;
      tf.local_tz[eTRow] = localPrime[11]!;
      (tf as any).dirty[eTRow] = 1;
    }

    // Link change (O(1) detach/append)
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
      tf.local_tx[eTRow] = tf.world_tx[eTRow]!;
      tf.local_r10[eTRow] = tf.world_r10[eTRow]!;
      tf.local_r11[eTRow] = tf.world_r11[eTRow]!;
      tf.local_r12[eTRow] = tf.world_r12[eTRow]!;
      tf.local_ty[eTRow] = tf.world_ty[eTRow]!;
      tf.local_r20[eTRow] = tf.world_r20[eTRow]!;
      tf.local_r21[eTRow] = tf.world_r21[eTRow]!;
      tf.local_r22[eTRow] = tf.world_r22[eTRow]!;
      tf.local_tz[eTRow] = tf.world_tz[eTRow]!;
      (tf as any).dirty[eTRow] = 1;
    }

    // Detach from hierarchy (O(1))
    detachFromParent(this.nodeStore, entity);

    this.bump(entity);
    this.rebuildOrder();
  }

  dispose() {
    this.world.unregisterHierarchy(this.componentName);
  }
}

/** Auto-detect all hierarchy component stores and return trees keyed by component name. */
export function buildAllHierarchyTrees(world: World): Map<string, HierarchyTree> {
  const trees = new Map<string, HierarchyTree>();
  const namesSet = new Set<string>();

  const worldAny = world as any;

  // Prefer enumerating actual store objects if available (most robust).
  if (typeof worldAny.__forEachStore === "function") {
    worldAny.__forEachStore((name: string, store: NodeStore) => {
      if (isHierarchyStore(store)) {
        namesSet.add(name);
        if (!trees.has(name)) trees.set(name, new HierarchyTree(world, store));
      }
    });
  } else if (typeof worldAny.__listStoreNames === "function") {
    // Fallback: list names then look them up.
    const names: string[] = worldAny.__listStoreNames();
    for (const n of names) {
      try {
        const store = world.store(n);
        if (isHierarchyStore(store)) {
          namesSet.add(n);
          if (!trees.has(n)) trees.set(n, new HierarchyTree(world, store));
        }
      } catch {
        /* ignore unknown */
      }
    }
  } else {
    // Last resort: try known canonical names (won’t find AuxNode etc., but keeps legacy callers alive)
    for (const n of ["TransformNode", "RenderNode"]) {
      try {
        const store = world.store(n);
        if (isHierarchyStore(store)) {
          namesSet.add(n);
          if (!trees.has(n)) trees.set(n, new HierarchyTree(world, store));
        }
      } catch { /* ignore */ }
    }
  }

  return trees;
}

/** Optional convenience wrappers for legacy callsites. */
export class TransformTree extends HierarchyTree {
  constructor(world: World) {
    super(world, world.store("TransformNode"));
  }
}
export class RenderTree extends HierarchyTree {
  constructor(world: World) {
    super(world, world.store("RenderNode"));
  }
}
