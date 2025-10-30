// tests/componentStore.test.ts
import { ComponentStore, type ComponentSchema } from "../src/ecs/core";

const DummySchema: ComponentSchema = {
  i: { ctor: Int32Array },
  x: { ctor: Float32Array },
};

describe("ComponentStore (scalar SoA)", () => {
  test("add initializes zero then applies initial scalars", () => {
    // ensure capacity easily covers entity ids we use
    const store = new ComponentStore("Dummy", DummySchema, 16);
    const e = 0;
    const row = store.add(e, { i: 42 });
    expect(row).toBe(0);
    expect(store.size).toBe(1);
    const { i, x } = store.fields() as any;
    expect(i[row]).toBe(42);
    expect(x[row]).toBeCloseTo(0);
    expect(store.denseToEntity[row]).toBe(e);
    expect(store.entityToDense[e]).toBe(row);
    expect(store.rowVersion[row]).toBe(1);
    expect(store.storeEpoch).toBe(1);
  });

  test("update writes only provided fields and bumps rowVersion + storeEpoch", () => {
    const store = new ComponentStore("Dummy", DummySchema, 16);
    const e = 0;
    store.add(e, { i: 1, x: 2.5 });
    const rvBefore = store.rowVersion[0];
    const epochBefore = store.storeEpoch;
    const updated = store.update(e, { x: 9.5 });
    expect(updated).toBe(true);
    const { i, x } = store.fields() as any;
    expect(i[0]).toBe(1);
    expect(x[0]).toBeCloseTo(9.5);
    expect(store.rowVersion[0]).toBe(rvBefore + 1);
    expect(store.storeEpoch).toBe(epochBefore + 1);
  });

  test("remove swap-removes and remaps dense<->entity", () => {
    const store = new ComponentStore("Dummy", DummySchema, 16);
    const a = 0, b = 1, c = 2; // small ids within capacity
    store.add(a, { i: 100 });
    store.add(b, { i: 200 });
    store.add(c, { i: 300 });
    // remove middle dense row (entity b)
    const ok = store.remove(b);
    expect(ok).toBe(true);
    expect(store.size).toBe(2);
    // b removed
    expect(store.entityToDense[b]).toBe(-1);
    // last (c) should be moved into b's old dense slot (1)
    expect(store.entityToDense[c]).toBe(1);
    expect(store.denseToEntity[1]).toBe(c);
  });

  test("grow doubles capacity and preserves data", () => {
    const store = new ComponentStore("Dummy", DummySchema, 1);
    for (let e = 0; e < 10; e++) store.add(e, { i: e });
    expect(store.capacity).toBeGreaterThanOrEqual(10);
    expect(store.size).toBe(10);
    const { i } = store.fields() as any;
    for (let row = 0; row < store.size; row++) {
      const ent = store.denseToEntity[row];
      expect(i[row]).toBe(ent);
    }
  });

  test("update on missing entity is a no-op", () => {
    const store = new ComponentStore("Dummy", DummySchema, 1);
    const before = store.storeEpoch;
    const ok = store.update(999, { i: 1 });
    expect(ok).toBe(false);
    expect(store.storeEpoch).toBe(before);
  });
});
