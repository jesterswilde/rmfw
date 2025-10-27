// tests/repack.test.ts
import { EntityPool } from "../src/pools/entity";
import { NodeTree } from "../src/pools/nodeTree";
import { Mat34Pool } from "../src/pools/matrix";
import { repack } from "../src/systems/repack";
import { EntityType } from "../src/entityDef";
import { Vector3 } from "../src/utils/math";
import { snapshotBuffers, views, readNode, expectEncodedFree } from "./testUtils";

describe("repack()", () => {
  it("compacts deterministically, remaps xforms, preserves payloads, and is idempotent (with stable static IDs)", () => {
    const entities = new EntityPool(16);
    const nodes = new NodeTree(16);
    const mats = new Mat34Pool(16);

    const el = EntityPool.Layout;
    const nl = NodeTree.Layout;
    const ml = Mat34Pool.Layout;

    const vNodes = () => nodes.getBufferViews();
    const vEnts  = () => entities.getBufferViews();
    const vMats  = () => mats.getBufferViews();

    // ---- Entities (identifiable payloads) ----
    const e1 = entities.create({ type: EntityType.Sphere, xformID: 1, material: 7, radius: 1.25 });
    const e2 = entities.create({ type: EntityType.Box,    xformID: 2, material: 9, bounds: new Vector3(2,3,4) });
    const e3 = entities.create({ type: EntityType.Sphere, xformID: 3, material: 5, radius: 3.5 });

    // ---- Transforms (local edits only; NO propagation) ----
    const m1 = mats.create(true); mats.setTranslation(m1, new Vector3(10, 0, 0)); // local.TX=10
    const m2 = mats.create(true); mats.setTranslation(m2, new Vector3(0, 20, 0)); // local.TY=20
    const m3 = mats.create(true); mats.setTranslation(m3, new Vector3(0, 0, 30)); // unused by any node

    // ---- Tree (DFS pre-order we expect: 0, a, c, b) ----
    // 0
    // ├─ a (e1, m1)
    // │   └─ c (e3, -1)
    // └─ b (e2, m2)
    const b = nodes.addChild(0, 0, e2, m2);
    const a = nodes.addChild(0, 0, e1, m1);
    const c = nodes.addChild(a, 0, e3, -1);

    // Capture set of static IDs pre-repack (we check set equality after)
    const beforeStaticIds = (() => {
      const nBV = vNodes();
      const set = new Set<number>();
      for (const i of [0, a, b, c]) set.add(readNode(nBV, i).staticId);
      return set;
    })();

    // Precondition sanity
    {
      const { gpuI32 } = vNodes();
      expect(gpuI32[nl.G.CHILD]).toBe(a);
      expect(gpuI32[a * nl.GPU_LANES + nl.G.SIB]).toBe(b);
      expect(gpuI32[a * nl.GPU_LANES + nl.G.CHILD]).toBe(c);
      expect(gpuI32[b * nl.GPU_LANES + nl.G.SIB]).toBe(-1);
    }

    // ---- Run repack once ----
    repack(nodes, entities, mats);

    // Snapshot for idempotency check
    const snap1 = snapshotBuffers(nodes, entities, mats);

    // ---- Run repack again (should be no-op) ----
    repack(nodes, entities, mats);
    const snap2 = snapshotBuffers(nodes, entities, mats);

    // Idempotency: byte-for-byte equality
    expect(snap2.nG).toEqual(snap1.nG);
    expect(snap2.nM).toEqual(snap1.nM);
    expect(snap2.eG).toEqual(snap1.eG);
    expect(snap2.eM).toEqual(snap1.eM);
    expect(snap2.mG).toEqual(snap1.mG);
    expect(snap2.mM).toEqual(snap1.mM);

    // ---- Post-conditions after repack #1 ----
    const { gpuI32: nGI32, metaI32: nMI32, idToIndex } = vNodes();
    const { gpuI32: eGI32, metaI32: eMI32 } = vEnts();
    const { gpuF32: mGF32, metaI32: mMI32, metaF32: mMF32 } = vMats();

    const node = (i: number) => ({
      entityIndex: nGI32[i * nl.GPU_LANES + nl.G.ENTITY_INDEX] | 0,
      child:       nGI32[i * nl.GPU_LANES + nl.G.CHILD] | 0,
      sib:         nGI32[i * nl.GPU_LANES + nl.G.SIB] | 0,
      parent:      nMI32[i * nl.META_LANES + nl.M.PARENT] | 0,
      status:      nMI32[i * nl.META_LANES + nl.M.STATUS] | 0,
      xform:       nMI32[i * nl.META_LANES + nl.M.XFORM_INDEX] | 0,
      staticId:    nMI32[i * nl.META_LANES + nl.M.STATIC_ID] | 0,
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
      expect(aN.xform).toBe(0); // first packed xform (from m1)

      // Mat 0 checks (NO propagation):
      // - LOCAL.TX preserved (10)
      // - WORLD is still identity (0 translation)
      // - GPU inverseWorld unchanged (identity → 0 translation)
      const mIdx = 0;

        const mb0 = mIdx * ml.META_LANES;       // meta base (absolute)
        expect(mMF32[mb0 + ml.M.L.TX]).toBeCloseTo(10, 6); // local TX
        expect(mMF32[mb0 + ml.M.W.TX]).toBeCloseTo(0, 6);  // world TX

        const g0 = mIdx * ml.GPU_LANES;
        expect(mGF32[g0 + ml.G.TX]).toBeCloseTo(0, 6);     // inverseWorld TX

      expect(mMI32[mIdx * ml.META_LANES + ml.M.STATUS]).toBe(0);
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
      expect(bN.xform).toBe(1); // second packed xform (from m2)

      // Mat 1 checks (NO propagation):
      const mIdx = 1;

      const mb1 = mIdx * ml.META_LANES;       // meta base (absolute)
      expect(mMF32[mb1 + ml.M.L.TY]).toBeCloseTo(20, 6); // local TY
      expect(mMF32[mb1 + ml.M.W.TY]).toBeCloseTo(0, 6);  // world TY

      const g1 = mIdx * ml.GPU_LANES;
      expect(mGF32[g1 + ml.G.TY]).toBeCloseTo(0, 6);     // inverseWorld TY


      expect(mMI32[mIdx * ml.META_LANES + ml.M.STATUS]).toBe(1);
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

    // Transforms GPU mirror unchanged (identity) without propagation; but non-zero sum check
    // is still valid if you want to keep it—here we check meta.local sums instead.
    const sumLocal = (matIdx: number) => {
      const base = matIdx * ml.META_LANES + ml.M.LOCAL_START;
      let s = 0;
      for (let k = 0; k < 12; k++) s += Math.abs(mMF32[base + k] || 0);
      return s;
    };
    expect(sumLocal(node(1).xform)).toBeGreaterThan(0); // has TX=10
    expect(sumLocal(node(3).xform)).toBeGreaterThan(0); // has TY=20

    // Free lists are rebuilt and encoded
    const firstFreeNodeStatus = nMI32[4 * nl.META_LANES + nl.M.STATUS] | 0;
    const firstFreeEntStatus  = eMI32[4 * el.META_LANES + el.M.STATUS] | 0;
    const firstFreeMatStatus  = mMI32[2 * ml.META_LANES + ml.M.STATUS] | 0; // only 2 mats used (m1,m2)
    expectEncodedFree(firstFreeNodeStatus);
    expectEncodedFree(firstFreeEntStatus);
    expectEncodedFree(firstFreeMatStatus);

    // ---- Static ID checks ----
    // (a) Set of static IDs preserved across repack
    const afterStaticIds = new Set<number>();
    for (let i = 0; i < nodes.size; i++) afterStaticIds.add(node(i).staticId);
    expect(afterStaticIds).toEqual(beforeStaticIds);

    // (b) idToIndex round-trip: for each node, idToIndex[staticId] == node index
    const { idToIndex: idMap } = vNodes();
    for (let i = 0; i < nodes.size; i++) {
      const sid = node(i).staticId;
      expect(idMap[sid] | 0).toBe(i);
    }

    // Pools remain valid
    expect(() => nodes.validate()).not.toThrow();
    expect(() => entities.validate()).not.toThrow();
    expect(() => mats.validate()).not.toThrow();
  });
});
