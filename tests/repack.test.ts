import { EntityPool } from "../src/pools/entity";
import { NodeTree } from "../src/pools/nodeTree";
import { Mat34Pool } from "../src/pools/matrix";
import { repack } from "../src/systems/repack";
import { EntityType } from "../src/entityDef";
import { Vector3 } from "../src/utils/math";

const snapshotBuffers = (nodes: NodeTree, ents: EntityPool, mats: Mat34Pool) => {
  const nBV = nodes.getBufferViews();
  const eBV = ents.getBufferViews();
  const mBV = mats.getBufferViews();
  return {
    nG: new Int32Array(nBV.gpuMirrorBuffer).slice(),
    nM: new Int32Array(nBV.metaBuffer).slice(),
    eG: new Int32Array(eBV.gpuMirrorBuffer).slice(),
    eM: new Int32Array(eBV.metaBuffer).slice(),
    mG: new Float32Array(mBV.gpuMirrorBuffer).slice(),
    mM: new Int32Array(mBV.metaBuffer).slice(),
  };
};

describe("repack()", () => {
  it("compacts deterministically, remaps xforms, preserves payloads, and is idempotent", () => {
    const entities = new EntityPool(16);
    const nodes = new NodeTree(16);
    const mats = new Mat34Pool(16);

    const el = EntityPool.Layout;
    const nl = NodeTree.Layout;
    const ml = Mat34Pool.Layout;

    const vNodes = () => nodes.getBufferViews();
    const vEnts  = () => entities.getBufferViews();
    const vMats  = () => mats.getBufferViews();

    // Entities (identifiable payloads)
    const e1 = entities.create({ type: EntityType.Sphere, xformID: 1, material: 7, radius: 1.25 });
    const e2 = entities.create({ type: EntityType.Box,    xformID: 2, material: 9, bounds: new Vector3(2,3,4) });
    const e3 = entities.create({ type: EntityType.Sphere, xformID: 3, material: 5, radius: 3.5 });

    // Transforms (distinct translations)
    const m1 = mats.create(true); mats.setTranslation(m1, new Vector3(10, 0, 0));
    const m2 = mats.create(true); mats.setTranslation(m2, new Vector3(0, 20, 0));
    const m3 = mats.create(true); mats.setTranslation(m3, new Vector3(0, 0, 30));

    // Tree (DFS pre-order we expect: 0, a, c, b)
    // 0
    // ├─ a (e1, m1)
    // │   └─ c (e3, -1)
    // └─ b (e2, m2)
    const b = nodes.addChild(0, 0, e2, m2);
    const a = nodes.addChild(0, 0, e1, m1);
    const c = nodes.addChild(a, 0, e3, -1);

    // Precondition sanity
    {
      const { gpuI32 } = vNodes();
      expect(gpuI32[nl.G.CHILD]).toBe(a);
      expect(gpuI32[a * nl.GPU_LANES + nl.G.SIB]).toBe(b);
      expect(gpuI32[a * nl.GPU_LANES + nl.G.CHILD]).toBe(c);
      expect(gpuI32[b * nl.GPU_LANES + nl.G.SIB]).toBe(-1);
    }

    // Run repack once
    repack(nodes, entities, mats);

    // Capture snapshot for idempotency check
    const snap1 = snapshotBuffers(nodes, entities, mats);

    // Run repack again (should be no-op in terms of ordering/data)
    repack(nodes, entities, mats);
    const snap2 = snapshotBuffers(nodes, entities, mats);

    // Idempotent: exact buffer equality across all pools
    expect(snap2.nG).toEqual(snap1.nG);
    expect(snap2.nM).toEqual(snap1.nM);
    expect(snap2.eG).toEqual(snap1.eG);
    expect(snap2.eM).toEqual(snap1.eM);
    expect(snap2.mG).toEqual(snap1.mG);
    expect(snap2.mM).toEqual(snap1.mM);

    // Post-conditions after repack #1
    const { gpuI32: nGI32, metaI32: nMI32 } = vNodes();
    const { gpuI32: eGI32, metaI32: eMI32 } = vEnts();
    const { gpuF32: mGF32, metaI32: mMI32 } = vMats();

    const node = (i: number) => ({
      entityIndex: nGI32[i * nl.GPU_LANES + nl.G.ENTITY_INDEX] | 0,
      child:       nGI32[i * nl.GPU_LANES + nl.G.CHILD] | 0,
      sib:         nGI32[i * nl.GPU_LANES + nl.G.SIB] | 0,
      parent:      nMI32[i * nl.META_LANES + nl.M.PARENT] | 0,
      status:      nMI32[i * nl.META_LANES + nl.M.STATUS] | 0,
      xform:       nMI32[i * nl.META_LANES + nl.M.XFORM_INDEX] | 0,
    });

    // DFS order: [0, a, c, b] -> new ids: 0,1,2,3
    {
      const r = node(0);
      expect(r.parent).toBe(-1);
      expect(r.status).toBe(0);
      expect(r.child).toBe(1);
    }
    {
      const aN = node(1);
      expect(aN.parent).toBe(0);
      expect(aN.child).toBe(2);
      expect(aN.sib).toBe(3);
      expect(aN.status).toBe(1);
      expect(aN.entityIndex).toBe(1);
      expect(aN.xform).toBe(0); // first packed xform
      const m0 = 0 * ml.GPU_LANES;
      expect(mGF32[m0 + ml.G.TX]).toBeCloseTo(10, 6);
      expect(mMI32[0 * ml.META_LANES + ml.M.STATUS]).toBe(0);
    }
    {
      const cN = node(2);
      expect(cN.parent).toBe(1);
      expect(cN.child).toBe(-1);
      expect(cN.sib).toBe(-1);
      expect(cN.status).toBe(2);
      expect(cN.entityIndex).toBe(2);
      expect(cN.xform).toBe(-1);
    }
    {
      const bN = node(3);
      expect(bN.parent).toBe(0);
      expect(bN.child).toBe(-1);
      expect(bN.sib).toBe(-1);
      expect(bN.status).toBe(3);
      expect(bN.entityIndex).toBe(3);
      expect(bN.xform).toBe(1); // second packed xform
      const m1 = 1 * ml.GPU_LANES;
      expect(mGF32[m1 + ml.G.TY]).toBeCloseTo(20, 6);
      expect(mMI32[1 * ml.META_LANES + ml.M.STATUS]).toBe(1);
    }

    // Entities 0..3 alive/aligned
    for (let i = 0; i < 4; i++) {
      expect(eMI32[i * el.META_LANES + el.M.STATUS]).toBe(i);
      const n = node(i);
      expect(n.entityIndex).toBe(i);
    }

    // Shape payloads preserved
    const typeOf = (idx: number) => eGI32[idx * el.GPU_LANES + el.G.H_TYPE] | 0;
    const f32Ent = new Float32Array(entities.getBufferViews().gpuMirrorBuffer);
    const v0x    = (idx: number) => f32Ent[idx * el.GPU_LANES + el.G.V0X]!;

    expect(typeOf(1)).toBe(EntityType.Sphere);
    expect(v0x(1)).toBeCloseTo(1.25, 6);

    expect(typeOf(3)).toBe(EntityType.Box);
    expect(v0x(3)).toBeCloseTo(2, 6);

    expect(typeOf(2)).toBe(EntityType.Sphere);
    expect(v0x(2)).toBeCloseTo(3.5, 6);

    // Entity H_XFORM remapped to node XFORM_INDEX (for shapes)
    const hXform = (idx: number) => eGI32[idx * el.GPU_LANES + el.G.H_XFORM] | 0;
    expect(hXform(1)).toBe(node(1).xform);
    expect(hXform(3)).toBe(node(3).xform);
    // c (2) has no xform
    expect(hXform(2)).toBe(-1);

    // Transforms are non-zero when they should be
    const sumMat = (matIdx: number) => {
      const base = matIdx * ml.GPU_LANES;
      let s = 0;
      for (let k = 0; k < ml.GPU_LANES; k++) s += Math.abs(mGF32[base + k] || 0);
      return s;
    };
    expect(sumMat(node(1).xform)).toBeGreaterThan(0);
    expect(sumMat(node(3).xform)).toBeGreaterThan(0);

    // Free lists are rebuilt and encoded
    const firstFreeNodeStatus = nMI32[4 * nl.META_LANES + nl.M.STATUS] | 0;
    const firstFreeEntStatus  = eMI32[4 * el.META_LANES + el.M.STATUS] | 0;
    const firstFreeMatStatus  = mMI32[2 * ml.META_LANES + ml.M.STATUS] | 0;
    expect(firstFreeNodeStatus).toBeLessThan(0);
    expect(firstFreeNodeStatus).not.toBe(-2);
    expect(firstFreeEntStatus).toBeLessThan(0);
    expect(firstFreeEntStatus).not.toBe(-2);
    expect(firstFreeMatStatus).toBeLessThan(0);
    expect(firstFreeMatStatus).not.toBe(-2);

    // Pools remain valid
    expect(() => nodes.validate()).not.toThrow();
    expect(() => entities.validate()).not.toThrow();
    expect(() => mats.validate()).not.toThrow();
  });
});
