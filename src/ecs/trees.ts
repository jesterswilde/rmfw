// src/ecs/trees.ts
import {type StoreOf } from "./index.js";
import { World} from "./core/world.js";
import { NONE, type NodeColumns } from "./interfaces.js";



function isHierarchyStore(store: StoreOf<any>): boolean {
  const m = (store as any).meta as
    | { fields: { key: string; ctor: any; link?: boolean }[] }
    | undefined;
  if (!m || !Array.isArray(m.fields)) return false;

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

/** Returns true if maybeAncestor is (strict) ancestor of node. */
function isAncestor(
  nodeStore: StoreOf<any>,
  maybeAncestor: number,
  node: number
): boolean {
  if (maybeAncestor === node || maybeAncestor === NONE || node === NONE)
    return false;

  const cols = nodeStore.fields() as any;
  let slow = node,
    fast = node;
  for (let hops = 0; hops < nodeStore.size; hops++) {
    const sRow = nodeStore.denseIndexOf(slow);
    if (sRow < 0) return false;
    slow = cols.parent[sRow] | 0;
    if (slow === maybeAncestor) return true;
    if (slow === NONE) return false;

    for (let k = 0; k < 2; k++) {
      const fRow = nodeStore.denseIndexOf(fast);
      if (fRow < 0) return false;
      fast = cols.parent[fRow] | 0;
      if (fast === maybeAncestor) return true;
      if (fast === NONE) return false;
    }
    if (slow === fast) return false;
  }
  return false;
}

/** Compute a deterministic DFS order starting at the provided root entity. */
function computeDFSFromRoot(nodeStore: StoreOf<any>, rootEntity: number): Int32Array {
  const cols = nodeStore.fields() as unknown as NodeColumns;
  const ordered: number[] = [];

  // simple stack walk (enter/leave) beginning at root
  let stack = new Int32Array(64);
  const ensure = (needTop: number) => {
    if (needTop < stack.length) return;
    let n = stack.length;
    while (n <= needTop) n = Math.max(2, n << 1);
    const next = new Int32Array(n);
    next.set(stack);
    stack = next;
  };

  const MAX_STEPS = (nodeStore.size | 0) * 4 + 16;

  let top = 0;
  stack[top] = rootEntity | 0;
  let isPopping = false;
  let steps = 0;

  while (top >= 0 && steps++ <= MAX_STEPS) {
    const e = stack[top]!;
    const row = nodeStore.denseIndexOf(e);
    if (row < 0) {
      top--;
      isPopping = true;
      continue;
    }

    if (!isPopping) {
      // ENTER
      ordered.push(e);

      // descend to first child
      const fc = cols.firstChild[row]! | 0;
      if (fc !== NONE) {
        const nextTop = top + 1;
        ensure(nextTop);
        stack[nextTop] = fc;
        top = nextTop;
        isPopping = false;
        continue;
      }
      isPopping = true;
      continue;
    }

    // LEAVE: try sibling
    const sib = cols.nextSibling[row]! | 0;
    if (sib !== NONE) {
      stack[top] = sib;
      isPopping = false;
      continue;
    }

    // POP
    top--;
  }

  return Int32Array.from(ordered);
}

/** Base class: generic hierarchy (no transform math). */
export class HierarchyTree {
  readonly componentName: string;
  protected world: World;
  protected nodeStore: StoreOf<any>;
  protected _order: Int32Array = new Int32Array(0);
  protected _epoch = 0;
  protected _rootEntity: number;

  constructor(world: World, nodeStore: StoreOf<any>, rootEntity: number) {
    if (!isHierarchyStore(nodeStore))
      throw new Error("HierarchyTree: node store schema mismatch");
    this.world = world;
    this.nodeStore = nodeStore;
    this.componentName = (nodeStore as any).name as string;
    this._rootEntity = rootEntity | 0;

    this.world.registerHierarchy(this.componentName, {
      remove: (e: number) => this.remove(e),
      componentName: this.componentName,
    });

    this.rebuildOrder();
  }

  get order(): Int32Array {
    return this._order;
  }
  get epoch(): number {
    return this._epoch;
  }
  root(): number {
    return this._rootEntity;
  }

  protected bump(entityHint?: number) {
    this._epoch++;
    if (entityHint != null && entityHint >= 0) {
      const id = entityHint | 0;
      if (id < this.world.entityEpoch.length)
        this.world.entityEpoch[id] = (this.world.entityEpoch[id]! + 1) >>> 0;
    }
  }

  rebuildOrder() {
    this._order = computeDFSFromRoot(this.nodeStore, this._rootEntity);
    this._epoch++;
  }

  /** Narrow untyped fields() to our explicit NodeColumns shape. */
  protected nodeColumns(): NodeColumns {
    return this.nodeStore.fields() as unknown as NodeColumns;
  }

  /** detach from current parent/sibling list, if any. */
  protected detachFromParent(entityId: number) {
    const cols = this.nodeColumns();
    const row = this.nodeStore.denseIndexOf(entityId);
    if (row < 0) return;

    const parent = cols.parent[row]! | 0;
    if (parent === NONE) return;

    const parentRow = this.nodeStore.denseIndexOf(parent);
    if (parentRow < 0) return;

    const prev = cols.prevSibling[row]! | 0;
    const next = cols.nextSibling[row]! | 0;

    if (prev === NONE) {
      cols.firstChild[parentRow] = next;
    } else {
      const prevRow = this.nodeStore.denseIndexOf(prev)!;
      cols.nextSibling[prevRow] = next;
    }

    if (next === NONE) {
      cols.lastChild[parentRow] = prev;
    } else {
      const nextRow = this.nodeStore.denseIndexOf(next)!;
      cols.prevSibling[nextRow] = prev;
    }

    cols.parent[row] = NONE;
    cols.prevSibling[row] = NONE;
    cols.nextSibling[row] = NONE;
  }

  /** append child at end  */
  protected appendChildAtEnd(parentEntityId: number, childEntityId: number) {
    const cols = this.nodeColumns();
    const pRow = this.nodeStore.denseIndexOf(parentEntityId);
    const cRow = this.nodeStore.denseIndexOf(childEntityId);
    if (pRow < 0 || cRow < 0)
      throw new Error("appendChildAtEnd: missing node component(s)");

    const tail = cols.lastChild[pRow]! | 0;
    if (tail === NONE) {
      cols.firstChild[pRow] = childEntityId | 0;
      cols.lastChild[pRow] = childEntityId | 0;
      cols.prevSibling[cRow] = NONE;
      cols.nextSibling[cRow] = NONE;
    } else {
      const tailRow = this.nodeStore.denseIndexOf(tail)!;
      cols.nextSibling[tailRow] = childEntityId | 0;
      cols.prevSibling[cRow] = tail | 0;
      cols.nextSibling[cRow] = NONE;
      cols.lastChild[pRow] = childEntityId | 0;
    }
    cols.parent[cRow] = parentEntityId | 0;
  }

  /** Ensure the entity has the node component with neutral defaults. */
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
    if (child === this._rootEntity)
      throw new Error("Cannot parent the tree root under another node");
    this.ensureNode(parent);
    this.ensureNode(child);
    this.detachFromParent(child);
    this.appendChildAtEnd(parent, child);
    this.bump(child);
    this.rebuildOrder();
  }

  /** Detach subtree root from its parent (becomes a direct child of NONE; root stays as NONE). */
  remove(entity: number) {
    if (entity === this._rootEntity)
      throw new Error("Cannot detach/remove the tree root");
    if (!this.nodeStore.has(entity)) return;
    this.detachFromParent(entity);
    this.bump(entity);
    this.rebuildOrder();
  }

  /** Structure-only reparent (no transform math). */
  reparentSimple(entity: number, newParent: number) {
    if (entity === newParent)
      throw new Error("Cannot parent an entity to itself");
    if (entity === this._rootEntity)
      throw new Error("Cannot reparent the tree root");
    this.ensureNode(entity);
    this.ensureNode(newParent);

    if (isAncestor(this.nodeStore, entity, newParent)) {
      throw new Error(
        "Cannot reparent: target parent is a descendant of the entity"
      );
    }

    this.detachFromParent(entity);
    this.appendChildAtEnd(newParent, entity);

    this.bump(entity);
    this.rebuildOrder();
  }

  /** Make `entity` a direct child of the tree root (structure only). */
  makeRootSimple(entity: number) {
    if (entity === this._rootEntity) return;
    this.ensureNode(entity);
    this.detachFromParent(entity);
    this.appendChildAtEnd(this._rootEntity, entity);
    this.bump(entity);
    this.rebuildOrder();
  }

  dispose() {
    this.world.unregisterHierarchy(this.componentName);
  }
}
