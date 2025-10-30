// tests/entityAllocator.test.ts
import { EntityAllocator } from "../src/ecs/core";

describe("EntityAllocator", () => {
  test("create → dense/sparse mapping and isAlive", () => {
    const ea = new EntityAllocator(4);
    const a = ea.create();
    const b = ea.create();
    expect(a).toBe(0);
    expect(b).toBe(1);
    expect(ea.size).toBe(2);
    expect(ea.isAlive(a)).toBe(true);
    expect(ea.isAlive(b)).toBe(true);
    expect(ea.denseIndexOf(a)).toBe(0);
    expect(ea.denseIndexOf(b)).toBe(1);
  });

  test("destroy swaps last, updates mappings, bumps entityEpoch", () => {
    const ea = new EntityAllocator(4);
    const ids = [ea.create(), ea.create(), ea.create()]; // 0,1,2
    expect(ea.size).toBe(3);
    const epochBefore = ea.entityEpoch[ids[1]];
    // Destroy middle (id=1). Should swap with last (id=2)
    ea.destroy(ids[1]);
    expect(ea.isAlive(ids[1])).toBe(false);
    expect(ea.size).toBe(2);
    expect(ea.dense[0]).toBe(0);
    expect(ea.dense[1]).toBe(2);
    expect(ea.denseIndexOf(2)).toBe(1);
    expect(ea.entityEpoch[ids[1]]).toBe((epochBefore + 1) >>> 0);
  });

  test("free list reuse", () => {
    const ea = new EntityAllocator(1);
    const a = ea.create(); // 0
    const b = ea.create(); // 1
    ea.destroy(a);
    const c = ea.create(); // should reuse id=0
    expect(c).toBe(a);
    expect(ea.isAlive(c)).toBe(true);
  });

  test("grows capacity on demand", () => {
    const ea = new EntityAllocator(1);
    const count = 10;
    for (let i = 0; i < count; i++) ea.create();
    expect(ea.capacity).toBeGreaterThanOrEqual(count);
    expect(ea.size).toBe(count);
  });
});
