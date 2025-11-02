// src/ecs/trees.ts
import { NONE, type StoreOf, type World } from "../core/index.js";

/** Explicit shape of the hierarchical node columns in a SoA store. */
interface NodeColumns {
  parent: Int32Array;      // -1 if root
  firstChild: Int32Array;  // head of singly-linked child list
  lastChild: Int32Array;   // tail of singly-linked child list (O(1) append)
  nextSibling: Int32Array; // next sibling in list
  prevSibling: Int32Array; // previous sibling in list (O(1) unlink)
}

type NodeStore = StoreOf<any>;
type DataStore = StoreOf<any>;

export function isHierarchyStore(store: NodeStore): boolean {
  const m = (store as any).meta as
    | { fields: { key: string; ctor: any; link?: boolean }[] }
    | undefined;
  if (!m || !Array.isArray(m.fields)) return false;

  // Require all five links in the Phase-2 schema.
  const need = new Set(["parent", "firstChild", "lastChild", "nextSibling", "prevSibling"]);
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
export function nodeColumns(store: NodeStore): NodeColumns {
  return store.fields() as unknown as NodeColumns;
}

/** Returns true if maybeAncestor is (strict) ancestor of node. */
export function isAncestor(nodeStore: NodeStore, maybeAncestor: number, node: number): boolean {
  if (maybeAncestor === node || maybeAncestor === NONE || node === NONE) return false;

  const cols = nodeColumns(nodeStore);
  let slow = node, fast = node;
  for (let hops = 0; hops < nodeStore.size; hops++) {
    const sRow = nodeStore.denseIndexOf(slow);
    if (sRow < 0) return false;
    slow = cols.parent[sRow]! | 0;
    if (slow === maybeAncestor) return true;
    if (slow === NONE) return false;

    for (let k = 0; k < 2; k++) {
      const fRow = nodeStore.denseIndexOf(fast);
      if (fRow < 0) return false;
      fast = cols.parent[fRow]! | 0;
      if (fast === maybeAncestor) return true;
      if (fast === NONE) return false;
    }
    if (slow === fast) return false;
  }
  return false;
}

/** detach from current parent/sibling list, if any. */
export function detachFromParent(nodeStore: NodeStore, entityId: number) {
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
    cols.firstChild[parentRow] = next;
  } else {
    const prevRow = nodeStore.denseIndexOf(prev)!;
    cols.nextSibling[prevRow] = next;
  }

  if (next === NONE) {
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
export function appendChildAtEnd(nodeStore: NodeStore, parentEntityId: number, childEntityId: number) {
  const cols = nodeColumns(nodeStore);
  const pRow = nodeStore.denseIndexOf(parentEntityId);
  const cRow = nodeStore.denseIndexOf(childEntityId);
  if (pRow < 0 || cRow < 0) throw new Error("appendChildAtEnd: missing node component(s)");

  const tail = cols.lastChild[pRow]! | 0;
  if (tail === NONE) {
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
function computeDFSOrder(nodeStore: NodeStore, explicitRootEntityId: number): Int32Array {
  const cols = nodeColumns(nodeStore);
  const ordered: number[] = [];

  // Start from the single root (row 0’s entity id).
  const root = explicitRootEntityId | 0;

  // Single stack + isPopping enter/leave walk.
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
  ensure(top);
  stack[top] = root;

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
      // ENTER node
      ordered.push(e);

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

    const sib = cols.nextSibling[row]! | 0;
    if (sib !== NONE) {
      stack[top] = sib;
      isPopping = false;
      continue;
    }

    top--;
  }

  return Int32Array.from(ordered);
}

/** Base class: single-root tree that binds a data store and a node store. */
export class Tree {
  readonly componentName: string; // node component name
  protected world: World;
  protected nodeStore: NodeStore;
  protected dataStore: DataStore;
  protected _order: Int32Array = new Int32Array(0);
  protected _epoch = 0;
  protected readonly rootEntity: number;

  /**
   * Construct a single-root tree:
   * - Registers the data and node metas (throws if already registered).
   * - Creates a new entity for the root.
   * - Adds data row 0 with provided rootData and node row 0 with parent = NONE.
   * - Protects the root entity in the World (cannot be deleted).
   */
  constructor(
    world: World,
    dataMeta: Readonly<{ name: string; fields: readonly any[] }>,
    nodeMeta: Readonly<{ name: string; fields: readonly any[] }>,
    rootData: Record<string, number>
  ) {
    this.world = world;

    // Register components (error if already registered).
    const dataDef = { meta: dataMeta } as const;
    const nodeDef = { meta: nodeMeta } as const;

    const dataStore = world.register(dataDef);
    const nodeStore = world.register(nodeDef);

    if (!isHierarchyStore(nodeStore as any)) {
      throw new Error(`Node meta '${nodeMeta.name}' does not satisfy hierarchy schema`);
    }
    if (dataStore.size !== 0 || nodeStore.size !== 0) {
      throw new Error("Tree creation requires empty stores (row 0 reserved for root)");
    }

    // Create a single root entity, shared by both stores at dense row 0.
    const root = world.createEntity();
    dataStore.add(root, rootData as any);
    nodeStore.add(root, {
      parent: NONE, firstChild: NONE, lastChild: NONE, nextSibling: NONE, prevSibling: NONE,
    } as any);

    // Verify row 0 for both stores belongs to the same entity.
    const d0 = dataStore.denseToEntity[0]!;
    const n0 = nodeStore.denseToEntity[0]!;
    if (d0 !== root || n0 !== root) {
      throw new Error("Root must occupy dense row 0 in both data and node stores");
    }

    // Protect root from deletion.
    world.protectEntity(root);

    this.nodeStore = nodeStore;
    this.dataStore = dataStore;
    this.rootEntity = root;
    this.componentName = (nodeStore as any).name as string;

    this.world.registerHierarchy(this.componentName, {
      remove: (e: number) => this.remove(e),
      componentName: this.componentName,
    });

    this.rebuildOrder();
  }

  get order(): Int32Array { return this._order; }
  get epoch(): number { return this._epoch; }
  get root(): number { return this.rootEntity; }

  protected bump(entityHint?: number) {
    this._epoch++;
    if (entityHint != null && entityHint >= 0) {
      const id = entityHint | 0;
      if (id < this.world.entityEpoch.length)
        this.world.entityEpoch[id] = (this.world.entityEpoch[id]! + 1) >>> 0;
    }
  }

  protected rebuildOrder() {
    this._order = computeDFSOrder(this.nodeStore, this.rootEntity);
    this._epoch++;
  }

  /** Disallow creating node rows implicitly; the tree owns membership. */
  protected assertMember(entity: number) {
    if (!this.nodeStore.has(entity))
      throw new Error(`Entity ${entity} is not a member of ${this.componentName}`);
  }

  /**
   * Set parent; -1 coerces to root. Root cannot be reparented.
   * For base tree this is structural only (no transform math).
   */
  setParent(entity: number, parent: number) {
    const e = entity | 0;
    const p = parent === NONE ? this.rootEntity : (parent | 0);

    if (e === this.rootEntity) throw new Error("Cannot reparent the root");
    this.assertMember(e);

    // Parent must be root or a member node.
    if (p !== this.rootEntity && !this.nodeStore.has(p))
      throw new Error(`Parent ${p} is not a member of ${this.componentName}`);

    if (isAncestor(this.nodeStore, e, p)) {
      throw new Error("Cannot set parent: target parent is a descendant of the entity");
    }

    // No-op if already the same parent.
    const cols = nodeColumns(this.nodeStore);
    const eRow = this.nodeStore.denseIndexOf(e);
    const curParent = cols.parent[eRow]! | 0;
    if (curParent === p) return;

    // O(1) detach + append.
    detachFromParent(this.nodeStore, e);
    appendChildAtEnd(this.nodeStore, p, e);

    this.bump(e);
    this.rebuildOrder();
  }

  /**
   * Remove an entity from the tree:
   * - Root: throws.
   * - All children of the removed entity become children of the root,
   *   preserving their original sibling order (O(k) bulk relink).
   * - The entity is then deleted from the world (tears down all components).
   */
  remove(entity: number) {
    const e = entity | 0;
    if (e === this.rootEntity) throw new Error("Cannot remove the root");
    this.assertMember(e);

    const cols = nodeColumns(this.nodeStore);
    const eRow = this.nodeStore.denseIndexOf(e)!;

    // 1) Capture the child chain of e.
    const fc = cols.firstChild[eRow]! | 0;
    const lc = cols.lastChild[eRow]! | 0;

    // 2) Detach 'e' from its current parent.
    detachFromParent(this.nodeStore, e);

    // 3) Splice child list under root (preserve order), updating parent pointers.
    if (fc !== NONE) {
      const root = this.rootEntity;
      const rRow = this.nodeStore.denseIndexOf(root)!;

      const rootTail = cols.lastChild[rRow]! | 0;
      if (rootTail === NONE) {
        cols.firstChild[rRow] = fc;
        cols.lastChild[rRow] = lc;
        const fcRow = this.nodeStore.denseIndexOf(fc)!;
        cols.prevSibling[fcRow] = NONE;
      } else {
        const rtRow = this.nodeStore.denseIndexOf(rootTail)!;
        cols.nextSibling[rtRow] = fc;
        const fcRow = this.nodeStore.denseIndexOf(fc)!;
        cols.prevSibling[fcRow] = rootTail;
        cols.lastChild[rRow] = lc;
      }

      // Update parent for all nodes in the moved chain.
      // Walk the sibling list from fc to lc.
      let cur = fc;
      for (let guard = 0; guard < this.nodeStore.size && cur !== NONE; guard++) {
        const cRow = this.nodeStore.denseIndexOf(cur);
        if (cRow < 0) break;
        cols.parent[cRow] = root;
        if (cur === lc) break;
        cur = cols.nextSibling[cRow]! | 0;
      }
    }

    // 4) Clear e's child pointers (not strictly necessary before deletion).
    cols.firstChild[eRow] = NONE;
    cols.lastChild[eRow] = NONE;

    // 5) Delete the entity from the world (will remove node/data stores too).
    this.world.destroyEntitySafe(e, /*removeFromTrees*/ false);

    this.bump();
    this.rebuildOrder();
  }

  dispose() {
    // Unprotect root (optional; kept to allow world teardown).
    this.world.unprotectEntity(this.rootEntity);
    this.world.unregisterHierarchy(this.componentName);
  }
}