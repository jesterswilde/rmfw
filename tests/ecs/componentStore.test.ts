// tests/ecs/componentStore.test.ts
import { ComponentStore } from "../../src/ecs/core/componentStore.js";
import type { ComponentMeta } from "../../src/ecs/interfaces.js";

describe("ComponentStore", () => {
  const meta: ComponentMeta<"TestStore", "x" | "y" | "z"> = {
    name: "TestStore",
    fields: [
      { key: "x", ctor: Float32Array, default: 1 },
      { key: "y", ctor: Int32Array },
      { key: "z", ctor: Uint32Array, default: 7 },
    ],
  };

  it("constructs typed columns and grows without losing values", () => {
    const store = new ComponentStore(meta, 1);

    const initialFields = store.fields();
    expect(initialFields.x).toBeInstanceOf(Float32Array);
    expect(initialFields.y).toBeInstanceOf(Int32Array);
    expect(initialFields.z).toBeInstanceOf(Uint32Array);
    expect(initialFields.x.length).toBe(1);

    store.add(1);
    expect(store.size).toBe(1);
    let fields = store.fields();
    expect(fields.x[0]).toBeCloseTo(1);
    expect(fields.y[0]).toBe(0);
    expect(fields.z[0]).toBe(7);

    store.add(2, { x: 4, y: -5, z: 9 });
    expect(store.capacity).toBeGreaterThanOrEqual(2);
    fields = store.fields();
    expect(fields.x.length).toBeGreaterThanOrEqual(2);
    expect(fields.x[0]).toBeCloseTo(1);
    expect(fields.y[0]).toBe(0);
    expect(fields.z[0]).toBe(7);
    expect(fields.x[1]).toBeCloseTo(4);
    expect(fields.y[1]).toBe(-5);
    expect(fields.z[1]).toBe(9);
  });

  it("adds new entities with defaults, overrides, and epochs", () => {
    const store = new ComponentStore(meta, 4);

    expect(store.storeEpoch).toBe(0);
    const dense = store.add(1, { y: -3 });
    expect(dense).toBe(0);
    expect(store.size).toBe(1);
    expect(store.storeEpoch).toBe(1);
    expect(store.rowVersion[dense]).toBe(1);

    const fields = store.fields();
    expect(fields.x[dense]).toBeCloseTo(1);
    expect(fields.y[dense]).toBe(-3);
    expect(fields.z[dense]).toBe(7);
    expect(store.denseToEntity[dense]).toBe(1);
    expect(store.entityToDense[1]).toBe(0);
  });

  it("reuses dense rows when re-adding an existing entity", () => {
    const store = new ComponentStore(meta, 4);
    store.add(1, { x: 2, y: 4, z: 6 });
    expect(store.storeEpoch).toBe(1);
    expect(store.rowVersion[0]).toBe(1);

    const denseAgain = store.add(1, { x: 8 });
    expect(denseAgain).toBe(0);
    expect(store.fields().x[0]).toBeCloseTo(8);
    expect(store.storeEpoch).toBe(2);
    expect(store.rowVersion[0]).toBe(2);
    expect(store.size).toBe(1);
  });

  it("updates rows only when values change", () => {
    const store = new ComponentStore(meta, 4);
    store.add(3, { x: 10, y: 1, z: 2 });
    expect(store.storeEpoch).toBe(1);
    expect(store.rowVersion[0]).toBe(1);

    const unchanged = store.update(3, { x: 10 });
    expect(unchanged).toBe(false);
    expect(store.storeEpoch).toBe(1);
    expect(store.rowVersion[0]).toBe(1);

    const changed = store.update(3, { y: -6 });
    expect(changed).toBe(true);
    expect(store.storeEpoch).toBe(2);
    expect(store.rowVersion[0]).toBe(2);
    expect(store.fields().y[0]).toBe(-6);

    const missing = store.update(99, { x: 5 });
    expect(missing).toBe(false);
    expect(store.storeEpoch).toBe(2);
  });

  it("swap-removes rows and maintains mappings", () => {
    const store = new ComponentStore(meta, 2);
    store.add(0, { x: 1, y: 10, z: 100 });
    store.add(1, { x: 2, y: 20, z: 200 });
    store.add(2, { x: 3, y: 30, z: 300 });
    expect(store.size).toBe(3);
    const fieldsBefore = store.fields();
    expect(Array.from(fieldsBefore.x.slice(0, store.size))).toEqual([1, 2, 3]);

    const removed = store.remove(1);
    expect(removed).toBe(true);
    expect(store.size).toBe(2);
    expect(store.has(1)).toBe(false);
    expect(store.storeEpoch).toBe(4);

    const fields = store.fields();
    const liveEntities = [store.denseToEntity[0], store.denseToEntity[1]];
    expect(new Set(liveEntities)).toEqual(new Set([0, 2]));

    const denseOfTwo = store.entityToDense[2];
    expect(denseOfTwo).toBeGreaterThanOrEqual(0);
    expect(fields.x[denseOfTwo]).toBeCloseTo(3);
    expect(fields.y[denseOfTwo]).toBe(30);
    expect(fields.z[denseOfTwo]).toBe(300);

    expect(store.rowVersion[denseOfTwo]).toBe(1);
    expect(store.rowVersion[store.size]).toBe(0);

    const absent = store.remove(999);
    expect(absent).toBe(false);
    expect(store.size).toBe(2);
  });

  it("keeps size and membership consistent after mixed operations", () => {
    const store = new ComponentStore(meta, 1);
    const entities = [0, 1, 2, 3, 4];
    for (const id of entities) {
      store.add(id, { x: id, y: id * 2, z: id * 3 });
    }

    store.remove(2);
    store.update(3, { x: 99 });
    store.add(2, { y: -2 });
    store.remove(0);

    const expectedLive = entities.filter((id) => store.has(id));
    expect(store.size).toBe(expectedLive.length);

    const expectedValues: Record<number, [number, number, number]> = {
      1: [1, 2, 3],
      2: [1, -2, 7],
      3: [99, 6, 9],
      4: [4, 8, 12],
    };

    const fields = store.fields();
    for (let dense = 0; dense < store.size; dense++) {
      const entity = store.denseToEntity[dense];
      expect(store.entityToDense[entity]).toBe(dense);
      expect(store.has(entity)).toBe(true);

      const [expectedX, expectedY, expectedZ] = expectedValues[entity]!;
      expect(fields.x[dense]).toBeCloseTo(expectedX);
      expect(fields.y[dense]).toBe(expectedY);
      expect(fields.z[dense]).toBe(expectedZ);
    }
  });

  it("remaps entity ids and link fields", () => {
    const linkMeta: ComponentMeta<"Links", "a" | "b" | "scalar"> = {
      name: "Links",
      fields: [
        { key: "a", ctor: Int32Array, default: -1, link: true },
        { key: "b", ctor: Int32Array, default: -1, link: true },
        { key: "scalar", ctor: Float32Array, default: 0 },
      ],
    };
    const store = new ComponentStore(linkMeta, 4);
    // Live entities: 0,1,2. Set up links using raw entity ids.
    store.add(0, { a: -1, b: 2, scalar: 1 });
    store.add(1, { a: 0, b: -1, scalar: 2 });
    store.add(2, { a: 1, b: -1, scalar: 3 });

    // Remap: 0->10, 1->11, 2->12
    const remap = new Int32Array(13).fill(-1);
    remap[0] = 10; remap[1] = 11; remap[2] = 12;

    store.remapEntitiesAndLinks(remap);
    const f = store.fields() as any;

    // denseToEntity updated
    expect(Array.from(store.denseToEntity.slice(0, store.size))).toEqual([10, 11, 12]);
    // entityToDense updated (new ids point to original rows 0..2)
    expect(store.entityToDense[10]).toBe(0);
    expect(store.entityToDense[11]).toBe(1);
    expect(store.entityToDense[12]).toBe(2);

    // Link fields remapped
    expect(f.a[0]).toBe(-1);      // NONE preserved
    expect(f.b[0]).toBe(12);      // old 2 -> 12
    expect(f.a[1]).toBe(10);      // old 0 -> 10
    expect(f.a[2]).toBe(11);      // old 1 -> 11

    // Scalar untouched
    expect(f.scalar[0]).toBeCloseTo(1);
    expect(f.scalar[1]).toBeCloseTo(2);
    expect(f.scalar[2]).toBeCloseTo(3);
  });

  it("export/import round-trip preserves the store", () => {
    const store = new ComponentStore(meta, 2);
    store.add(5, { x: 9, y: -3, z: 2 });
    store.add(7, { x: 4, y: 0, z: 1 });
    store.remove(5);
    const snapshot = store.export();

    const restored = new ComponentStore(meta, 1);
    restored.import(snapshot);

    expect(restored.name).toBe(store.name);
    expect(restored.size).toBe(store.size);
    expect(restored.capacity).toBe(store.capacity);
    expect(Array.from(restored.denseToEntity.slice(0, restored.size)))
      .toEqual(Array.from(store.denseToEntity.slice(0, store.size)));
    expect(Array.from(restored.entityToDense)).toEqual(Array.from(store.entityToDense));
    expect(Array.from(restored.rowVersion)).toEqual(Array.from(store.rowVersion));

    const fA = store.fields();
    const fB = restored.fields();
    for (const key of Object.keys(fA) as Array<keyof typeof fA>) {
      expect(Array.from(fB[key] as any)).toEqual(Array.from(fA[key] as any));
    }
  });
});
