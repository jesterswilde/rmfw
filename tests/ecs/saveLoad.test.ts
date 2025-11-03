// tests/ecs/saveLoad.test.ts
import { World } from "../../src/ecs/core/world.js";
import type { ComponentMeta, Def } from "../../src/ecs/interfaces.js";
import { saveWorld, saveWorldToJSON, loadWorld, loadWorldFromJSON } from "../../src/ecs/saveLoad.js";
import { Tree } from "../../src/ecs/tree/tree.js";

type Vec2 = "x" | "y";
type LinkKeys = "parent" | "next" | "prev";
type ColorKeys = "r" | "g" | "b";
type TreeNodeKeys = "parent" | "firstChild" | "lastChild" | "nextSibling" | "prevSibling";

const positionMeta: ComponentMeta<"Position", Vec2> = {
  name: "Position",
  fields: [
    { key: "x", ctor: Float32Array, default: 0 },
    { key: "y", ctor: Float32Array, default: 0 },
  ],
};

const linksMeta: ComponentMeta<"Links", LinkKeys> = {
  name: "Links",
  fields: [
    { key: "parent", ctor: Int32Array, default: -1, link: true },
    { key: "next", ctor: Int32Array, default: -1, link: true },
    { key: "prev", ctor: Int32Array, default: -1, link: true },
  ],
};

const colorMeta: ComponentMeta<"Color", ColorKeys> = {
  name: "Color",
  fields: [
    { key: "r", ctor: Float32Array, default: 0 },
    { key: "g", ctor: Float32Array, default: 0 },
    { key: "b", ctor: Float32Array, default: 0 },
  ],
};

const treeDataMeta: ComponentMeta<"TreeData", "value"> = {
  name: "TreeData",
  fields: [{ key: "value", ctor: Float32Array, default: 0 }],
};

const treeNodeMeta: ComponentMeta<"TreeNode", TreeNodeKeys> = {
  name: "TreeNode",
  fields: [
    { key: "parent", ctor: Int32Array, default: -1, link: true },
    { key: "firstChild", ctor: Int32Array, default: -1, link: true },
    { key: "lastChild", ctor: Int32Array, default: -1, link: true },
    { key: "nextSibling", ctor: Int32Array, default: -1, link: true },
    { key: "prevSibling", ctor: Int32Array, default: -1, link: true },
  ],
};

const positionDef: Def<typeof positionMeta> = { meta: positionMeta } as const;
const linksDef: Def<typeof linksMeta> = { meta: linksMeta } as const;
const colorDef: Def<typeof colorMeta> = { meta: colorMeta } as const;
const treeDataDef: Def<typeof treeDataMeta> = { meta: treeDataMeta } as const;
const treeNodeDef: Def<typeof treeNodeMeta> = { meta: treeNodeMeta } as const;

describe("Save/Load JSON", () => {
  it("round-trip with densify=true compacts ids, remaps link fields, and preserves store data", () => {
    // Build a world with sparse ids and a protected id
    const w = new World({ initialCapacity: 2 });
    const P = w.register(positionDef, 2);
    const L = w.register(linksDef, 2);

    // Create 5 entities, remove some to force sparsity: live = {0,2,4}
    const e0 = w.createEntity(); // 0
    const e1 = w.createEntity(); // 1
    const e2 = w.createEntity(); // 2
    const e3 = w.createEntity(); // 3
    const e4 = w.createEntity(); // 4

    // Add components for the live set
    P.add(e0, { x: 1, y: 2 });
    P.add(e2, { x: 3, y: 4 });
    P.add(e4, { x: 5, y: 6 });

    L.add(e0, { parent: -1, next: e2, prev: -1 });
    L.add(e2, { parent: e0, next: e4, prev: e0 });
    L.add(e4, { parent: e0, next: -1, prev: e2 });

    // Remove 1 and 3 to make sparsity
    w.destroyEntity(e1);
    w.destroyEntity(e3);

    // Protect e0 (root-like)
    w.protectEntity(e0);

    // Save with densify (default)
    const json = saveWorldToJSON(w); // densify=true

    // Load into a fresh world with same metas
    const w2 = new World({ initialCapacity: 1 });
    const P2 = w2.register(positionDef, 1);
    const L2 = w2.register(linksDef, 1);

    loadWorldFromJSON(w2, json);

    // After densify: live ids must be 0,1,2 (ascending old-id order mapping: 0->0, 2->1, 4->2)
    expect(w2.entities.size).toBe(3);
    expect(Array.from(w2.entities.dense)).toEqual([0, 1, 2]);

    // Protected set remapped (old 0 -> new 0)
    expect(w2.isEntityProtected(0)).toBe(true);
    expect(w2.isEntityProtected(1)).toBe(false);
    expect(w2.isEntityProtected(2)).toBe(false);

    // Position data preserved and aligned to new dense ids
    const pf = P2.fields();
    // Map new id -> expected values (from original e0,e2,e4)
    // new 0 (old 0) -> (1,2)
    // new 1 (old 2) -> (3,4)
    // new 2 (old 4) -> (5,6)
    const e0Row = P2.denseIndexOf(0);
    const e1Row = P2.denseIndexOf(1);
    const e2Row = P2.denseIndexOf(2);
    expect(pf.x[e0Row]).toBeCloseTo(1);
    expect(pf.y[e0Row]).toBeCloseTo(2);
    expect(pf.x[e1Row]).toBeCloseTo(3);
    expect(pf.y[e1Row]).toBeCloseTo(4);
    expect(pf.x[e2Row]).toBeCloseTo(5);
    expect(pf.y[e2Row]).toBeCloseTo(6);

    // Links must be remapped to compact ids
    const lf = L2.fields() as any;
    // For new ids (0,1,2), we expect a simple chain 0 -> 1 -> 2 with parent of 1 and 2 equal to 0
    expect(lf.next[L2.entityToDense[0]]).toBe(1);
    expect(lf.parent[L2.entityToDense[1]]).toBe(0);
    expect(lf.next[L2.entityToDense[1]]).toBe(2);
    expect(lf.prev[L2.entityToDense[1]]).toBe(0);
    expect(lf.parent[L2.entityToDense[2]]).toBe(0);
    expect(lf.prev[L2.entityToDense[2]]).toBe(1);
    expect(lf.next[L2.entityToDense[2]]).toBe(-1);

    // Epoch buffers length sanity (entityEpoch is a live view over allocator buffer)
    expect(w2.entityEpoch.length).toBeGreaterThanOrEqual(3);
  });

  it("round-trip with densify=false preserves allocator and store buffers exactly", () => {
    const w = new World({ initialCapacity: 2 });
    const P = w.register(positionDef, 2);
    const L = w.register(linksDef, 2);

    const ids = [w.createEntity(), w.createEntity(), w.createEntity(), w.createEntity(), w.createEntity()];
    expect(ids).toEqual([0, 1, 2, 3, 4]);

    // Sparse: remove 1 and 3
    w.destroyEntity(1);
    w.destroyEntity(3);

    // Live are [0,2,4] in some dense order (allocator dense)
    P.add(0, { x: 10, y: 20 });
    P.add(2, { x: 30, y: 40 });
    P.add(4, { x: 50, y: 60 });

    L.add(0, { parent: -1, next: 2, prev: -1 });
    L.add(2, { parent: 0, next: 4, prev: 0 });
    L.add(4, { parent: 0, next: -1, prev: 2 });

    // Protect 0
    w.protectEntity(0);

    // Save without densify
    const snap = saveWorld(w, { densify: false });

    // New world, register metas and load
    const w2 = new World({ initialCapacity: 1 });
    const P2 = w2.register(positionDef, 1);
    const L2 = w2.register(linksDef, 1);

    loadWorld(w2, snap);

    // Allocator arrays equal
    expect(Array.from(w2.entities.dense)).toEqual(Array.from(snap.allocator._dense));
    expect(w2.entities.size).toBe(w.entities.size);
    expect(w2.entities.capacity).toBeGreaterThanOrEqual(w.entities.capacity);

    // Protected ids same (0 is still protected)
    expect(w2.isEntityProtected(0)).toBe(true);

    // Store mappings preserved (no remap)
    expect(Array.from(P2.denseToEntity)).toEqual(Array.from(snap.components.Position.denseToEntity));
    expect(Array.from(P2.entityToDense)).toEqual(Array.from(snap.components.Position.entityToDense));
    expect(Array.from(L2.denseToEntity)).toEqual(Array.from(snap.components.Links.denseToEntity));
    expect(Array.from(L2.entityToDense)).toEqual(Array.from(snap.components.Links.entityToDense));

    // Field arrays preserved exactly
    const pf2 = P2.fields();
    const lf2 = L2.fields() as any;
    const savedP = snap.components.Position.fields;
    const savedL = snap.components.Links.fields;

    expect(Array.from(pf2.x)).toEqual(savedP.x);
    expect(Array.from(pf2.y)).toEqual(savedP.y);
    expect(Array.from(lf2.parent)).toEqual(savedL.parent);
    expect(Array.from(lf2.next)).toEqual(savedL.next);
    expect(Array.from(lf2.prev)).toEqual(savedL.prev);
  });

  it("handles mixed stores with differing capacities", () => {
    const w = new World({ initialCapacity: 1 });
    const P = w.register(positionDef, 1);
    const L = w.register(linksDef, 4);
    const C = w.register(colorDef, 1);

    const e0 = w.createEntity();
    const e1 = w.createEntity();
    const e2 = w.createEntity();

    P.add(e0, { x: 1, y: 2 });
    P.add(e1, { x: 3, y: 4 });
    P.add(e2, { x: 5, y: 6 });

    L.add(e0, { parent: -1, next: e1, prev: -1 });
    L.add(e1, { parent: e0, next: e2, prev: e0 });
    L.add(e2, { parent: e0, next: -1, prev: e1 });

    C.add(e0, { r: 1, g: 0.5, b: 0.25 });
    C.add(e1, { r: 0.1, g: 0.2, b: 0.3 });
    C.add(e2, { r: 0.7, g: 0.8, b: 0.9 });

    const snap = saveWorld(w);

    const w2 = new World({ initialCapacity: 1 });
    const P2 = w2.register(positionDef, 1);
    const L2 = w2.register(linksDef, 1);
    const C2 = w2.register(colorDef, 1);

    loadWorld(w2, snap);

    expect(P2.size).toBe(3);
    expect(L2.size).toBe(3);
    expect(C2.size).toBe(3);

    expect(P2.capacity).toBe(snap.components.Position.capacity);
    expect(L2.capacity).toBe(snap.components.Links.capacity);
    expect(C2.capacity).toBe(snap.components.Color.capacity);

    const pf = P2.fields();
    const lf = L2.fields() as any;
    const cf = C2.fields();

    const row0 = P2.denseIndexOf(0);
    const row1 = P2.denseIndexOf(1);
    const row2 = P2.denseIndexOf(2);

    expect(pf.x[row0]).toBeCloseTo(1);
    expect(pf.y[row0]).toBeCloseTo(2);
    expect(pf.x[row1]).toBeCloseTo(3);
    expect(pf.y[row1]).toBeCloseTo(4);
    expect(pf.x[row2]).toBeCloseTo(5);
    expect(pf.y[row2]).toBeCloseTo(6);

    expect(cf.r[row0]).toBeCloseTo(1);
    expect(cf.g[row0]).toBeCloseTo(0.5);
    expect(cf.b[row0]).toBeCloseTo(0.25);
    expect(cf.r[row1]).toBeCloseTo(0.1);
    expect(cf.g[row1]).toBeCloseTo(0.2);
    expect(cf.b[row1]).toBeCloseTo(0.3);
    expect(cf.r[row2]).toBeCloseTo(0.7);
    expect(cf.g[row2]).toBeCloseTo(0.8);
    expect(cf.b[row2]).toBeCloseTo(0.9);

    expect(lf.parent[L2.entityToDense[0]]).toBe(-1);
    expect(lf.next[L2.entityToDense[0]]).toBe(1);
    expect(lf.parent[L2.entityToDense[1]]).toBe(0);
    expect(lf.next[L2.entityToDense[1]]).toBe(2);
    expect(lf.prev[L2.entityToDense[1]]).toBe(0);
    expect(lf.parent[L2.entityToDense[2]]).toBe(0);
    expect(lf.prev[L2.entityToDense[2]]).toBe(1);
    expect(lf.next[L2.entityToDense[2]]).toBe(-1);
  });

  it("rehydrates registered trees using provided rehydrators", () => {
    const world = new World({ initialCapacity: 4 });
    const tree = new Tree(world, treeDataMeta, treeNodeMeta, { value: 99 });
    const dataStore = world.store("TreeData");
    const nodeStore = world.store("TreeNode");

    const addNode = (value: number) => {
      const entity = world.createEntity();
      (dataStore as any).add(entity, { value });
      (nodeStore as any).add(entity, { parent: -1, firstChild: -1, lastChild: -1, nextSibling: -1, prevSibling: -1 });
      tree.setParent(entity, tree.root);
      return entity;
    };

    const childA = addNode(1);
    const childB = addNode(2);
    tree.setParent(childB, childA);

    const snap = saveWorld(world);
    expect(snap.trees).toEqual([treeNodeMeta.name]);

    const world2 = new World({ initialCapacity: 1 });
    world2.register(treeDataDef, 1);
    world2.register(treeNodeDef, 1);

    let rehydrated: Tree | null = null;
    loadWorld(world2, snap, {
      [treeNodeMeta.name]: (w) => {
        rehydrated = Tree.rehydrate(w, treeDataMeta, treeNodeMeta);
      },
    });

    expect(rehydrated).not.toBeNull();
    const treeOrder = Array.from(rehydrated!.order);
    expect(treeOrder.length).toBe(3);
    expect(treeOrder[0]).toBe(rehydrated!.root);
    expect(world2.isEntityProtected(rehydrated!.root)).toBe(true);

    const nodeFields = (world2.store("TreeNode") as any).fields();
    const rootRow = (world2.store("TreeNode") as any).denseIndexOf(rehydrated!.root);
    const firstChild = nodeFields.firstChild[rootRow];
    expect(firstChild).not.toBe(-1);
    const firstChildRow = (world2.store("TreeNode") as any).denseIndexOf(firstChild);
    expect(nodeFields.parent[firstChildRow]).toBe(rehydrated!.root);
    const grandChild = nodeFields.firstChild[firstChildRow];
    expect(grandChild).not.toBe(-1);
    const grandChildRow = (world2.store("TreeNode") as any).denseIndexOf(grandChild);
    expect(nodeFields.parent[grandChildRow]).toBe(firstChild);

    const names: string[] = [];
    world2.forEachTree((name) => names.push(name));
    expect(names).toContain(treeNodeMeta.name);
  });

  it("throws when loading snapshots with missing component metas", () => {
    const w = new World({ initialCapacity: 2 });
    const P = w.register(positionDef, 1);
    const L = w.register(linksDef, 1);

    const entity = w.createEntity();
    P.add(entity, { x: 11, y: 22 });
    L.add(entity, { parent: -1, next: -1, prev: -1 });

    const snap = saveWorld(w);

    const w2 = new World({ initialCapacity: 1 });
    w2.register(positionDef, 1);

    expect(() => loadWorld(w2, snap)).toThrow(/Import failed: store 'Links' is not registered/);
  });

  it("ignores extra snapshot fields that are not part of the component meta", () => {
    const w = new World({ initialCapacity: 1 });
    const P = w.register(positionDef, 1);

    const entity = w.createEntity();
    P.add(entity, { x: 13, y: 17 });

    const snap = saveWorld(w, { densify: false });
    const mutated = JSON.parse(JSON.stringify(snap)) as any;
    mutated.components.Position.fields.extra = [999, 1000];

    const w2 = new World({ initialCapacity: 1 });
    const P2 = w2.register(positionDef, 1);

    loadWorld(w2, mutated);

    const row = P2.denseIndexOf(entity);
    expect(row).toBeGreaterThanOrEqual(0);
    const pf = P2.fields();
    expect(pf.x[row]).toBeCloseTo(13);
    expect(pf.y[row]).toBeCloseTo(17);
    expect((pf as any).extra).toBeUndefined();
  });
});
