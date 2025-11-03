// tests/ecs/saveLoad.test.ts
import { World } from "../../src/ecs/core/world.js";
import type { ComponentMeta, Def } from "../../src/ecs/interfaces.js";
import { saveWorld, saveWorldToJSON, loadWorld, loadWorldFromJSON } from "../../src/ecs/saveLoad.js";

type Vec2 = "x" | "y";
type LinkKeys = "parent" | "next" | "prev";

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
    { key: "next",   ctor: Int32Array, default: -1, link: true },
    { key: "prev",   ctor: Int32Array, default: -1, link: true },
  ],
};

const positionDef: Def<typeof positionMeta> = { meta: positionMeta } as const;
const linksDef: Def<typeof linksMeta> = { meta: linksMeta } as const;

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
});
