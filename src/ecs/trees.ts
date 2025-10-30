// Phase 2: CPU-only tree wrappers for hierarchical components.
// src/ecs/trees.ts
//
// - TransformTree and RenderTree maintain deterministic DFS orders and bump epochs.
// - addChild, remove (detach subtree), reparent.
// - Rebuild order arrays on structural change.

import { World, type StoreHandle } from "../ecs/core.js";
import { Transform, TransformNode, RenderNode } from "./registry.js";

const NONE = -1;

/** Explicit shape of the hierarchical node columns in a SoA store. */
interface NodeColumns {
  parent: Int32Array;      // -1 if root
  firstChild: Int32Array;  // head of singly-linked child list
  nextSibling: Int32Array; // next sibling in list
}

type NodeStore = StoreHandle<any>;

/** Narrow untyped fields() to our explicit NodeColumns shape. */
function nodeColumns(store: NodeStore): NodeColumns {
  return store.fields() as unknown as NodeColumns;
}

/** Detach an entity from its current parent, if any. */
function detachFromParent(nodeStore: NodeStore, entityId: number) {
  const cols = nodeColumns(nodeStore);
  const denseIndex = nodeStore.denseIndexOf(entityId);
  if (denseIndex < 0) return;

  const parentEntityId = cols.parent[denseIndex]! | 0;
  if (parentEntityId === NONE) return;

  const parentDenseIndex = nodeStore.denseIndexOf(parentEntityId);
  if (parentDenseIndex < 0) return;

  let previousSiblingEntityId = NONE;
  let currentSiblingEntityId = cols.firstChild[parentDenseIndex]! | 0;

  while (currentSiblingEntityId !== NONE) {
    const currentSiblingDenseIndex = nodeStore.denseIndexOf(currentSiblingEntityId);

    if (currentSiblingEntityId === entityId) {
      const nextSiblingEntityId = cols.nextSibling[currentSiblingDenseIndex]! | 0;

      if (previousSiblingEntityId === NONE) {
        // Removing the head of the child list.
        cols.firstChild[parentDenseIndex] = nextSiblingEntityId;
      } else {
        // Bridge previous → next to skip the removed node.
        const previousSiblingDenseIndex = nodeStore.denseIndexOf(previousSiblingEntityId)!;
        cols.nextSibling[previousSiblingDenseIndex] = nextSiblingEntityId;
      }

      // Clear this node's links.
      cols.parent[denseIndex] = NONE;
      cols.nextSibling[denseIndex] = NONE;
      return;
    }

    previousSiblingEntityId = currentSiblingEntityId;
    currentSiblingEntityId = cols.nextSibling[currentSiblingDenseIndex]! | 0;
  }
}

/** Append child at the end of the parent's child list (stable order among siblings). */
function appendChildAtEnd(nodeStore: NodeStore, parentEntityId: number, childEntityId: number) {
  const cols = nodeColumns(nodeStore);
  const parentDenseIndex = nodeStore.denseIndexOf(parentEntityId);
  const childDenseIndex = nodeStore.denseIndexOf(childEntityId);

  if (parentDenseIndex < 0 || childDenseIndex < 0) {
    throw new Error("appendChildAtEnd: missing node component(s)");
  }

  let lastChildEntityId = cols.firstChild[parentDenseIndex]! | 0;

  if (lastChildEntityId === NONE) {
    cols.firstChild[parentDenseIndex] = parentEntityId === NONE ? NONE : (childEntityId | 0);
  } else {
    // Walk to the tail sibling, then link the new child there.
    while (true) {
      const lastChildDenseIndex = nodeStore.denseIndexOf(lastChildEntityId)!;
      const nextSiblingEntityId = cols.nextSibling[lastChildDenseIndex]! | 0;
      if (nextSiblingEntityId === NONE) {
        cols.nextSibling[lastChildDenseIndex] = childEntityId | 0;
        break;
      }
      lastChildEntityId = nextSiblingEntityId;
    }
  }

  cols.parent[childDenseIndex] = parentEntityId | 0;
  cols.nextSibling[childDenseIndex] = NONE;
}

/** Compute a deterministic DFS order of entities for a given node store. */
function computeDFSOrder(nodeStore: NodeStore, explicitRootEntityIds?: number[]): Int32Array {
  const cols = nodeColumns(nodeStore);
  const orderedEntities: number[] = [];

  // Determine root set either from explicit roots or by scanning for parent == NONE.
  const rootEntityIds = new Set<number>();
  if (explicitRootEntityIds?.length) {
    for (const rootId of explicitRootEntityIds) rootEntityIds.add(rootId);
  } else {
    const denseToEntity = nodeStore.denseToEntity;
    for (let i = 0; i < nodeStore.size; i++) {
      const entityId = denseToEntity[i]!;
      const rowIndex = nodeStore.denseIndexOf(entityId)!;
      if ((cols.parent[rowIndex]! | 0) === NONE) rootEntityIds.add(entityId);
    }
  }

  // Deterministic root ordering by ascending entity id.
  const sortedRootEntityIds = Array.from(rootEntityIds.values()).sort((a, b) => a - b);

  // Iterative DFS using an explicit stack; push children in reverse to preserve left-to-right.
  const stack: number[] = [];
  const pushChildren = (entityId: number) => {
    const rowIndex = nodeStore.denseIndexOf(entityId)!;
    const childBuffer: number[] = [];
    let childEntityId = cols.firstChild[rowIndex]! | 0;
    while (childEntityId !== NONE) {
      childBuffer.push(childEntityId);
      const childRow = nodeStore.denseIndexOf(childEntityId)!;
      childEntityId = cols.nextSibling[childRow]! | 0;
    }
    for (let i = childBuffer.length - 1; i >= 0; i--) stack.push(childBuffer[i]!);
  };

  for (let i = sortedRootEntityIds.length - 1; i >= 0; i--) {
    stack.push(sortedRootEntityIds[i]!);
  }

  while (stack.length) {
    const currentEntityId = stack.pop()!;
    orderedEntities.push(currentEntityId);
    pushChildren(currentEntityId);
  }

  return Int32Array.from(orderedEntities);
}

/** Base class: stores DFS order + epoch and exposes rebuild hook. */
class BaseTree {
  protected world: World;
  protected nodeStore: NodeStore;
  protected _depthFirstOrder: Int32Array = new Int32Array(0);
  protected _treeEpoch = 0;

  constructor(world: World, nodeStore: NodeStore) {
    this.world = world;
    this.nodeStore = nodeStore;
  }

  /** DFS order (root-first, stable sibling order). */
  get order(): Int32Array { return this._depthFirstOrder; }

  /** Tree epoch; bumps on structural change or order rebuild. */
  get epoch(): number { return this._treeEpoch; }

  /** Bump internal epoch and optionally the world's per-entity epoch. */
  protected bumpEpoch(entityHint?: number) {
    this._treeEpoch++;
    if (entityHint != null && entityHint >= 0) {
      const id = entityHint | 0;
      if (id < this.world.entityEpoch.length) {
        this.world.entityEpoch[id] = (this.world.entityEpoch[id]! + 1) >>> 0;
      }
    }
  }

  /** Recompute deterministic DFS order from current links. */
  rebuildOrder(explicitRootEntityIds?: number[]) {
    this._depthFirstOrder = computeDFSOrder(this.nodeStore, explicitRootEntityIds);
    this._treeEpoch++;
  }
}

/** TransformTree: ensures Transform is present and manages hierarchy under TransformNode. */
export class TransformTree extends BaseTree {
  constructor(world: World) {
    super(world, world.store(TransformNode.meta.name));
  }

  /** Ensure this entity has both Transform and TransformNode components. */
  private ensureTransformNode(entityId: number) {
    const transformStore = this.world.store(Transform.meta.name);
    const transformNodeStore = this.nodeStore;
    if (!transformStore.has(entityId)) transformStore.add(entityId);
    if (!transformNodeStore.has(entityId)) {
      transformNodeStore.add(entityId, { parent: NONE, firstChild: NONE, nextSibling: NONE });
    }
  }

  addChild(parentEntityId: number, childEntityId: number) {
    this.ensureTransformNode(parentEntityId);
    this.ensureTransformNode(childEntityId);
    detachFromParent(this.nodeStore, childEntityId);
    appendChildAtEnd(this.nodeStore, parentEntityId, childEntityId);
    this.bumpEpoch(childEntityId);
    this.rebuildOrder();
  }

  /** Detach the subtree rooted at entityId; it becomes a root. */
  remove(entityId: number) {
    if (!this.nodeStore.has(entityId)) return;
    detachFromParent(this.nodeStore, entityId);
    this.bumpEpoch(entityId);
    this.rebuildOrder();
  }

  /** Move a subtree under a new parent (append as last child). */
  reparent(entityId: number, newParentEntityId: number) {
    if (entityId === newParentEntityId) throw new Error("Cannot parent an entity to itself");
    this.ensureTransformNode(entityId);
    this.ensureTransformNode(newParentEntityId);
    detachFromParent(this.nodeStore, entityId);
    appendChildAtEnd(this.nodeStore, newParentEntityId, entityId);
    this.bumpEpoch(entityId);
    this.rebuildOrder();
  }
}

/** RenderTree: manages hierarchy under RenderNode. */
export class RenderTree extends BaseTree {
  constructor(world: World) {
    super(world, world.store(RenderNode.meta.name));
  }

  /** Ensure this entity has a RenderNode component. */
  private ensureRenderNode(entityId: number) {
    if (!this.nodeStore.has(entityId)) {
      this.nodeStore.add(entityId, { parent: NONE, firstChild: NONE, nextSibling: NONE });
    }
  }

  addChild(parentEntityId: number, childEntityId: number) {
    this.ensureRenderNode(parentEntityId);
    this.ensureRenderNode(childEntityId);
    detachFromParent(this.nodeStore, childEntityId);
    appendChildAtEnd(this.nodeStore, parentEntityId, childEntityId);
    this.bumpEpoch(childEntityId);
    this.rebuildOrder();
  }

  remove(entityId: number) {
    if (!this.nodeStore.has(entityId)) return;
    detachFromParent(this.nodeStore, entityId);
    this.bumpEpoch(entityId);
    this.rebuildOrder();
  }

  reparent(entityId: number, newParentEntityId: number) {
    if (entityId === newParentEntityId) throw new Error("Cannot parent an entity to itself");
    this.ensureRenderNode(entityId);
    this.ensureRenderNode(newParentEntityId);
    detachFromParent(this.nodeStore, entityId);
    appendChildAtEnd(this.nodeStore, newParentEntityId, entityId);
    this.bumpEpoch(entityId);
    this.rebuildOrder();
  }
}
