// tests/ecs/entityAllocator.test.ts
import { EntityAllocator } from "../../src/ecs/core/entityAllocator.js";

describe("EntityAllocator", () => {
  it("creates consecutive entities and grows capacity", () => {
    const alloc = new EntityAllocator(1);
    const created: number[] = [];
    for (let i = 0; i < 6; i++) {
      created.push(alloc.create());
    }

    expect(created).toEqual([0, 1, 2, 3, 4, 5]);
    expect(alloc.size).toBe(6);
    expect(alloc.capacity).toBeGreaterThanOrEqual(6);
    expect(Array.from(alloc.dense)).toEqual(created);

    for (const id of created) {
      expect(alloc.denseIndexOf(id)).toBe(id);
      expect(alloc.isAlive(id)).toBe(true);
      expect(alloc.entityEpoch[id]).toBe(0);
    }
  });

  it("destroy updates mappings, marks free, and reuses ids", () => {
    const alloc = new EntityAllocator(2);
    const ids = [alloc.create(), alloc.create(), alloc.create(), alloc.create()];
    expect(ids).toEqual([0, 1, 2, 3]);

    alloc.destroy(1);
    expect(alloc.isAlive(1)).toBe(false);
    expect(alloc.denseIndexOf(1)).toBe(-1);
    expect(alloc.entityEpoch[1]).toBe(1);

    const denseIds = Array.from(alloc.dense);
    expect(new Set(denseIds)).toEqual(new Set([0, 2, 3]));
    expect(alloc.denseIndexOf(3)).toBeLessThan(alloc.size);

    const reused = alloc.create();
    expect(reused).toBe(1);
    expect(alloc.isAlive(1)).toBe(true);
    expect(alloc.entityEpoch[1]).toBe(1);

    alloc.destroy(1);
    expect(alloc.entityEpoch[1]).toBe(2);
    expect(alloc.isAlive(1)).toBe(false);
    expect(alloc.denseIndexOf(1)).toBe(-1);
  });

  it("grows sparse arrays and handles destroys near the boundary", () => {
    const alloc = new EntityAllocator(2);
    for (let i = 0; i < 10; i++) {
      alloc.create();
    }
    expect(alloc.capacity).toBeGreaterThanOrEqual(10);
    expect(alloc.dense.length).toBe(10);

    alloc.destroy(9);
    expect(alloc.isAlive(9)).toBe(false);
    expect(alloc.denseIndexOf(9)).toBe(-1);
    expect(alloc.entityEpoch[9]).toBe(1);

    const reused = alloc.create();
    expect(reused).toBe(9);
    expect(alloc.isAlive(9)).toBe(true);
  });

  it("provides safe defaults for invalid destroys and lookups", () => {
    const alloc = new EntityAllocator(1);
    alloc.create();

    expect(() => alloc.destroy(-5 as unknown as number)).not.toThrow();
    expect(() => alloc.destroy(42)).not.toThrow();
    expect(alloc.isAlive(-1)).toBe(false);
    expect(alloc.isAlive(42)).toBe(false);
    expect(alloc.denseIndexOf(-1)).toBe(-1);
    expect(alloc.denseIndexOf(42)).toBe(-1);
  });

  it("computes a valid dense remap and applies it", () => {
    const alloc = new EntityAllocator(1);
    // Make a sparse shape: [0,1,2,3,4], then remove 1 and 3
    const ids = [alloc.create(), alloc.create(), alloc.create(), alloc.create(), alloc.create()];
    expect(ids).toEqual([0, 1, 2, 3, 4]);
    alloc.destroy(1);
    alloc.destroy(3);

    // Live set is whatever dense order currently holds (swap-removal may reorder).
    const { remap, inverse } = alloc.computeDenseRemap();

    // Verify bijection: remap[inverse[i]] === i
    expect(inverse.length).toBe(3);
    for (let i = 0; i < inverse.length; i++) {
      const oldId = inverse[i]!;
      expect(alloc.isAlive(oldId)).toBe(true);
      expect(remap[oldId]).toBe(i);
    }
    // Dead ids map to < 0
    expect(remap[1]).toBeLessThan(0);
    expect(remap[3]).toBeLessThan(0);

    const prevEpochs = Array.from(alloc.entityEpoch);

    alloc.applyRemap(remap);

    // After applyRemap, live ids are 0..size-1, free list cleared
    expect(Array.from(alloc.dense)).toEqual([0, 1, 2]);
    expect(alloc.size).toBe(3);
    expect(alloc.isAlive(0)).toBe(true);
    expect(alloc.isAlive(1)).toBe(true);
    expect(alloc.isAlive(2)).toBe(true);

    // Epochs for (new) live ids bumped by 1 relative to their source ids
    for (let newId = 0; newId < 3; newId++) {
      const oldId = inverse[newId]!;
      expect(alloc.entityEpoch[newId]).toBe((prevEpochs[oldId] ?? 0) + 1);
    }
  });

  it("export/import round-trip preserves allocator state", () => {
    const alloc = new EntityAllocator(2);
    for (let i = 0; i < 5; i++) alloc.create();
    alloc.destroy(1);
    alloc.destroy(3);
    const snap = alloc.export();

    const clone = new EntityAllocator(1);
    clone.import(snap);

    expect(clone.capacity).toBe(alloc.capacity);
    expect(clone.size).toBe(alloc.size);
    expect(Array.from(clone.dense)).toEqual(Array.from(alloc.dense));
    expect(Array.from(clone["entityEpoch"])).toEqual(Array.from(alloc["entityEpoch"]));
    expect(clone.isAlive(3)).toBe(false);
  });
});
