import { ComponentStore } from "../../src/ecs/core/componentStore.js";
import { World, NONE } from "../../src/ecs/core/index.js";
import type { ComponentMeta } from "../../src/ecs/interfaces.js";
import {
  Tree,
  isTreeStore,
  nodeColumns,
  isAncestor,
  detachFromParent,
  appendChildAtEnd,
} from "../../src/ecs/tree/tree.js";
import { TransformTree } from "../../src/ecs/tree/transformTree.js";
import { TransformNodeMeta, TransfromRoot } from "../../src/ecs/registry.js";

const hierarchyMeta: ComponentMeta<
  "HierarchyNode",
  "parent" | "firstChild" | "lastChild" | "nextSibling" | "prevSibling"
> = {
  name: "HierarchyNode",
  fields: [
    { key: "parent", ctor: Int32Array, default: NONE, link: true },
    { key: "firstChild", ctor: Int32Array, default: NONE, link: true },
    { key: "lastChild", ctor: Int32Array, default: NONE, link: true },
    { key: "nextSibling", ctor: Int32Array, default: NONE, link: true },
    { key: "prevSibling", ctor: Int32Array, default: NONE, link: true },
  ],
};

const badMeta: ComponentMeta<"BadNode", "parent" | "firstChild" | "lastChild"> = {
  name: "BadNode",
  fields: [
    { key: "parent", ctor: Float32Array, default: 0, link: true },
    { key: "firstChild", ctor: Int32Array, default: NONE, link: false },
    { key: "lastChild", ctor: Int32Array, default: NONE, link: true },
  ],
};

const treeDataMeta: ComponentMeta<"TreeData", "value"> = {
  name: "TreeData",
  fields: [{ key: "value", ctor: Float32Array, default: 0 }],
};

const rootData = { value: 1 } as const;

const emptyLinks = () => ({
  parent: NONE,
  firstChild: NONE,
  lastChild: NONE,
  nextSibling: NONE,
  prevSibling: NONE,
});

describe("Tree helpers", () => {
  it("validates hierarchy stores", () => {
    const goodStore = new ComponentStore(hierarchyMeta, 2);
    expect(isTreeStore(goodStore as any)).toBe(true);

    const badStore = new ComponentStore(badMeta, 2);
    expect(isTreeStore(badStore as any)).toBe(false);
  });

  it("narrows node columns and writes through", () => {
    const store = new ComponentStore(hierarchyMeta, 2);
    store.add(1, emptyLinks());
    const cols = nodeColumns(store);
    cols.parent[0] = 42;
    expect(store.fields().parent[0]).toBe(42);
  });

  it("detects ancestors and handles missing nodes", () => {
    const store = new ComponentStore(hierarchyMeta, 4);
    store.add(1, emptyLinks());
    store.add(2, emptyLinks());
    store.add(3, emptyLinks());

    appendChildAtEnd(store, 1, 2);
    appendChildAtEnd(store, 2, 3);

    expect(isAncestor(store, 1, 3)).toBe(true);
    expect(isAncestor(store, 2, 1)).toBe(false);
    expect(isAncestor(store, NONE, 3)).toBe(false);
    expect(isAncestor(store, 99, 3)).toBe(false);
  });

  it("detaches and appends while updating sibling chains", () => {
    const store = new ComponentStore(hierarchyMeta, 4);
    store.add(0, emptyLinks());
    store.add(1, emptyLinks());
    store.add(2, emptyLinks());

    appendChildAtEnd(store, 0, 1);
    appendChildAtEnd(store, 0, 2);

    const cols = nodeColumns(store);
    expect(cols.firstChild[store.denseIndexOf(0)]).toBe(1);
    expect(cols.lastChild[store.denseIndexOf(0)]).toBe(2);

    detachFromParent(store, 1);
    expect(cols.parent[store.denseIndexOf(1)]).toBe(NONE);
    expect(cols.firstChild[store.denseIndexOf(0)]).toBe(2);
    expect(cols.lastChild[store.denseIndexOf(0)]).toBe(2);

    appendChildAtEnd(store, 0, 1);
    expect(cols.lastChild[store.denseIndexOf(0)]).toBe(1);
    expect(cols.prevSibling[store.denseIndexOf(1)]).toBe(2);
    expect(cols.nextSibling[store.denseIndexOf(2)]).toBe(1);
  });
});

describe("Tree", () => {
  const makeTree = () => {
    const world = new World({ initialCapacity: 8 });
    const tree = new Tree(world, treeDataMeta, hierarchyMeta, { value: rootData.value });
    const dataStore = world.store("TreeData");
    const nodeStore = world.store("HierarchyNode");
    return { world, tree, dataStore, nodeStore };
  };

  const makeMember = (
    world: World,
    tree: Tree,
    dataStore: ReturnType<World["store"]>,
    nodeStore: ReturnType<World["store"]>,
    value: number
  ) => {
    const entity = world.createEntity();
    (dataStore as any).add(entity, { value });
    (nodeStore as any).add(entity, emptyLinks());
    tree.setParent(entity, tree.root);
    return entity;
  };

  it("constructs with protected root and cached order", () => {
    const { world, tree } = makeTree();
    expect(world.isEntityProtected(tree.root)).toBe(true);
    expect(Array.from(tree.order)).toEqual([tree.root]);

    const names: string[] = [];
    world.forEachTree((name) => names.push(name));
    expect(names).toContain("HierarchyNode");
  });

  it("grows stores while keeping data and links", () => {
    const { world, tree, dataStore, nodeStore } = makeTree();

    const target = 300;
    const added = new Map<number, number>();
    for (let i = 0; i < target; i++) {
      const e = world.createEntity();
      const value = i + 2;
      (dataStore as any).add(e, { value });
      (nodeStore as any).add(e, emptyLinks());
      tree.setParent(e, tree.root);
      added.set(e, value);
    }

    expect((dataStore as any).capacity).toBeGreaterThanOrEqual(target + 1);
    expect((nodeStore as any).capacity).toBeGreaterThanOrEqual(target + 1);
    const values = (dataStore as any).fields().value as Float32Array;
    for (const [entity, expected] of added) {
      const row = (dataStore as any).denseIndexOf(entity);
      expect(values[row]).toBeCloseTo(expected);
    }
    expect(tree.order.length).toBe(target + 1);
  });

  it("prevents duplicate metas per world", () => {
    const world = new World();
    new Tree(world, treeDataMeta, hierarchyMeta, { value: rootData.value });
    expect(() => new Tree(world, treeDataMeta, hierarchyMeta, { value: rootData.value })).toThrow();
  });

  it("removes nodes when world destroys them", () => {
    const { world, tree, dataStore, nodeStore } = makeTree();
    const entity = makeMember(world, tree, dataStore, nodeStore, 3);
    expect(tree.order).toContain(entity);

    world.destroyEntitySafe(entity);

    expect(tree.order).not.toContain(entity);
    expect((nodeStore as any).has(entity)).toBe(false);
    expect(world.entities.isAlive(entity)).toBe(false);
  });

  it("reparents children under new parents and bumps epoch", () => {
    const { world, tree, dataStore, nodeStore } = makeTree();
    const childA = makeMember(world, tree, dataStore, nodeStore, 10);
    const childB = makeMember(world, tree, dataStore, nodeStore, 20);
    const grand = makeMember(world, tree, dataStore, nodeStore, 30);
    tree.setParent(grand, childA);

    const prevEpoch = tree.epoch;
    tree.setParent(childB, childA);
    expect(tree.epoch).toBeGreaterThan(prevEpoch);

    const cols = nodeColumns(nodeStore as any);
    const bRow = (nodeStore as any).denseIndexOf(childB);
    expect(cols.parent[bRow]).toBe(childA);

    expect(tree.order[0]).toBe(tree.root);
    expect(tree.order).toContain(childA);
    expect(tree.order).toContain(childB);
    expect(tree.order).toContain(grand);
  });

  it("rejects invalid reparent operations", () => {
    const { world, tree, dataStore, nodeStore } = makeTree();
    const parent = makeMember(world, tree, dataStore, nodeStore, 5);
    const child = makeMember(world, tree, dataStore, nodeStore, 6);
    const grand = makeMember(world, tree, dataStore, nodeStore, 7);
    tree.setParent(child, parent);
    tree.setParent(grand, child);

    const stranger = 999;

    expect(() => tree.setParent(tree.root, child)).toThrow();
    expect(() => tree.setParent(child, stranger)).toThrow();
    expect(() => tree.setParent(parent, grand)).toThrow();

    const epochBefore = tree.epoch;
    tree.setParent(child, parent);
    expect(tree.epoch).toBe(epochBefore);
  });

  it("removes leaves and nodes with children", () => {
    const { world, tree, dataStore, nodeStore } = makeTree();
    const leaf = makeMember(world, tree, dataStore, nodeStore, 7);
    tree.remove(leaf);
    expect((nodeStore as any).has(leaf)).toBe(false);
    expect(world.entities.isAlive(leaf)).toBe(false);

    const parent = makeMember(world, tree, dataStore, nodeStore, 8);
    const child1 = makeMember(world, tree, dataStore, nodeStore, 9);
    const child2 = makeMember(world, tree, dataStore, nodeStore, 10);
    tree.setParent(child1, parent);
    tree.setParent(child2, parent);

    tree.remove(parent);
    const cols = nodeColumns(nodeStore as any);
    const rootRow = (nodeStore as any).denseIndexOf(tree.root);
    expect(cols.parent[(nodeStore as any).denseIndexOf(child1)]).toBe(tree.root);
    expect(cols.parent[(nodeStore as any).denseIndexOf(child2)]).toBe(tree.root);
    expect(cols.firstChild[rootRow]).toBe(child1);
    expect(cols.nextSibling[(nodeStore as any).denseIndexOf(child1)]).toBe(child2);
    expect(world.entities.isAlive(parent)).toBe(false);
  });

  it("rejects removing the root and disposes cleanly", () => {
    const { world, tree } = makeTree();
    expect(() => tree.remove(tree.root)).toThrow();
    tree.dispose();
    expect(world.isEntityProtected(tree.root)).toBe(false);
    const names: string[] = [];
    world.forEachTree((name) => names.push(name));
    expect(names).not.toContain("HierarchyNode");
  });
});

describe("TransformTree", () => {
  const makeTransformTree = () => {
    const world = new World({ initialCapacity: 8 });
    const tree = new TransformTree(world, TransformNodeMeta, TransfromRoot);
    const transformStore = world.store("Transform");
    const nodeStore = world.store("TransformNode");
    return { world, tree, transformStore, nodeStore };
  };

  const addTransformNode = (
    world: World,
    tree: TransformTree,
    transformStore: ReturnType<World["store"]>,
    nodeStore: ReturnType<World["store"]>,
    overrides: Partial<Record<string, number>>
  ) => {
    const entity = world.createEntity();
    (transformStore as any).add(entity, overrides);
    (nodeStore as any).add(entity, emptyLinks());
    tree.setParent(entity, tree.root);
    return entity;
  };

  it("preserves world transforms when reparenting", () => {
    const { world, tree, transformStore, nodeStore } = makeTransformTree();
    const parent = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 1,
      world_ty: 2,
      world_tz: 3,
    });
    const child = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 5,
      world_ty: 7,
      world_tz: 9,
    });

    const tf = (transformStore as any).fields();
    const childRow = (transformStore as any).denseIndexOf(child);
    const beforeWorld = {
      tx: tf.world_tx[childRow],
      ty: tf.world_ty[childRow],
      tz: tf.world_tz[childRow],
    };

    tree.setParent(child, parent);

    expect(tf.world_tx[childRow]).toBeCloseTo(beforeWorld.tx);
    expect(tf.world_ty[childRow]).toBeCloseTo(beforeWorld.ty);
    expect(tf.world_tz[childRow]).toBeCloseTo(beforeWorld.tz);

    const expectedLocal = {
      tx: beforeWorld.tx - tf.world_tx[(transformStore as any).denseIndexOf(parent)],
      ty: beforeWorld.ty - tf.world_ty[(transformStore as any).denseIndexOf(parent)],
      tz: beforeWorld.tz - tf.world_tz[(transformStore as any).denseIndexOf(parent)],
    };
    expect(tf.local_tx[childRow]).toBeCloseTo(expectedLocal.tx);
    expect(tf.local_ty[childRow]).toBeCloseTo(expectedLocal.ty);
    expect(tf.local_tz[childRow]).toBeCloseTo(expectedLocal.tz);
  });

  it("treats parents without transforms as identity", () => {
    const { world, tree, transformStore, nodeStore } = makeTransformTree();
    const parent = world.createEntity();
    (nodeStore as any).add(parent, emptyLinks());
    const child = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 2,
      world_ty: 3,
      world_tz: 4,
    });

    tree.setParent(parent, tree.root);
    tree.setParent(child, parent);

    const tf = (transformStore as any).fields();
    const childRow = (transformStore as any).denseIndexOf(child);
    expect(tf.world_tx[childRow]).toBeCloseTo(2);
    expect(tf.local_tx[childRow]).toBeCloseTo(2);
  });

  it("keeps child world transforms when removing parents", () => {
    const { world, tree, transformStore, nodeStore } = makeTransformTree();
    const parent = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 1,
      world_ty: 0,
      world_tz: 0,
    });
    const child = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 4,
      world_ty: 0,
      world_tz: 0,
    });
    tree.setParent(child, parent);

    const tf = (transformStore as any).fields();
    const childRow = (transformStore as any).denseIndexOf(child);
    const beforeWorld = tf.world_tx[childRow];

    tree.remove(parent);

    const newRow = (transformStore as any).denseIndexOf(child);
    expect(tf.world_tx[newRow]).toBeCloseTo(beforeWorld);
    expect(nodeColumns(nodeStore as any).parent[(nodeStore as any).denseIndexOf(child)]).toBe(tree.root);
  });

  it("handles nodes missing transform rows without crashing", () => {
    const { world, tree, transformStore, nodeStore } = makeTransformTree();
    const orphan = world.createEntity();
    (nodeStore as any).add(orphan, emptyLinks());
    tree.setParent(orphan, tree.root);

    expect(() => tree.setParent(orphan, tree.root)).not.toThrow();
    expect(() => tree.remove(orphan)).not.toThrow();
    expect(world.entities.isAlive(orphan)).toBe(false);
  });

  it("treats NONE parent as root while preserving world transforms", () => {
    const { world, tree, transformStore, nodeStore } = makeTransformTree();
    const child = addTransformNode(world, tree, transformStore, nodeStore, {
      world_tx: 6,
      world_ty: -2,
      world_tz: 1,
    });

    const tf = (transformStore as any).fields();
    const childRow = (transformStore as any).denseIndexOf(child);
    const before = {
      tx: tf.world_tx[childRow],
      ty: tf.world_ty[childRow],
      tz: tf.world_tz[childRow],
    };

    tree.setParent(child, NONE);

    expect(tf.world_tx[childRow]).toBeCloseTo(before.tx);
    expect(tf.world_ty[childRow]).toBeCloseTo(before.ty);
    expect(tf.world_tz[childRow]).toBeCloseTo(before.tz);
  });
});
