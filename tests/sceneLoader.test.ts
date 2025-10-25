import { parseScene } from "../src/systems/loadScene";
import { EntityPool } from "../src/pools/entity";
import { NodeTree } from "../src/pools/nodeTree";
import { Mat34Pool } from "../src/pools/matrix";
import { EntityType } from "../src/entityDef";

describe("parseScene", () => {
  it("loads nodes/entities/mats and preserves child order", () => {
    // input
    const scene = {
      version: 1,
      root: "root",
      nodes: [
        { id: "root", children: ["sub", "sphere2"], payload: 0 },
        { id: "sub", children: ["sphere", "box"], payload: 1 },
        { id: "sphere", payload: 2 },
        { id: "sphere2", payload: 3 },
        { id: "box", payload: 4 },
      ],
      payloads: [
        { type: 21 }, // SimpleUnion
        { type: 22 }, // SimpleSubtract
        { type: 1, position: [1, 0, 0], rotation: [0, 0, 0], radius: 0.3 },
        { type: 1, position: [3, 0, 0], rotation: [0, 0, 0], radius: 1.0 },
        { type: 2, position: [-1, 0, 0], rotation: [0, 0, 0], bounds: [1, 1, 1] },
      ],
    };

    // pools
    const entities = new EntityPool(16);
    const nodes = new NodeTree(16);
    const mats = new Mat34Pool(16);

    // load
    parseScene(scene as any, nodes, entities, mats);

    // views
    const nl = NodeTree.Layout;
    const el = EntityPool.Layout;
    const ml = Mat34Pool.Layout;

    const nBV = nodes.getBufferViews();
    const eBV = entities.getBufferViews();
    const mBV = mats.getBufferViews();

    const nGI = nBV.gpuI32;
    const nMI = nBV.metaI32;
    const eGI = eBV.gpuI32;
    const eMI = eBV.metaI32;
    const mGF = mBV.gpuF32;
    const mMI = mBV.metaI32;

    // helpers
    const nodeChild = (i: number) => nGI[i * nl.GPU_LANES + nl.G.CHILD] | 0;
    const nodeSib = (i: number) => nGI[i * nl.GPU_LANES + nl.G.SIB] | 0;
    const nodeEnt = (i: number) => nGI[i * nl.GPU_LANES + nl.G.ENTITY_INDEX] | 0;
    const nodeXf = (i: number) => nMI[i * nl.META_LANES + nl.M.XFORM_INDEX] | 0;
    const entType = (idx: number) => eGI[idx * el.GPU_LANES + el.G.H_TYPE] | 0;
    const entV0x = (idx: number) => {
      const f32 = new Float32Array(eBV.gpuMirrorBuffer);
      return f32[idx * el.GPU_LANES + el.G.V0X]!;
    };
    const mTx = (xf: number) => mGF[xf * ml.GPU_LANES + ml.G.TX]!;
    const mTy = (xf: number) => mGF[xf * ml.GPU_LANES + ml.G.TY]!;
    const mTz = (xf: number) => mGF[xf * ml.GPU_LANES + ml.G.TZ]!;

    // root
    expect(nodeEnt(0)).toBeGreaterThanOrEqual(0);
    expect(nodeXf(0)).toBe(-1);

    // root children order: ["sub", "sphere2"]
    const c0 = nodeChild(0);
    const s0 = nodeSib(c0);
    expect(c0).toBeGreaterThan(0);
    expect(s0).toBeGreaterThan(0);

    // first child should be SimpleSubtract (payload type 22)
    const c0Ent = nodeEnt(c0);
    expect(entType(c0Ent)).toBe(EntityType.SimpleSubtract);
    expect(nodeXf(c0)).toBe(-1);

    // its sibling should be Sphere at x=3 with radius 1.0 (stored as inverse transform)
    const s0Ent = nodeEnt(s0);
    expect(entType(s0Ent)).toBe(EntityType.Sphere);
    const s0Xf = nodeXf(s0);
    expect(s0Xf).toBeGreaterThanOrEqual(0);
    expect(mTx(s0Xf)).toBeCloseTo(-3, 6); // inverse of position [3,0,0]
    expect(mTy(s0Xf)).toBeCloseTo(0, 6);
    expect(mTz(s0Xf)).toBeCloseTo(0, 6);
    expect(entV0x(s0Ent)).toBeCloseTo(1.0, 6); // radius in V0X

    // second-level under "sub": children order ["sphere", "box"]
    const c1 = nodeChild(c0);
    const s1 = nodeSib(c1);
    expect(c1).toBeGreaterThan(0);
    expect(s1).toBeGreaterThan(0);

    // "sphere" at x=1, radius 0.3 (stored as inverse transform)
    const c1Ent = nodeEnt(c1);
    expect(entType(c1Ent)).toBe(EntityType.Sphere);
    const c1Xf = nodeXf(c1);
    expect(mTx(c1Xf)).toBeCloseTo(-1, 6); // inverse of position [1,0,0]
    expect(entV0x(c1Ent)).toBeCloseTo(0.3, 6);

    // "box" at x=-1, bounds [1,1,1] (stored as inverse transform)
    const s1Ent = nodeEnt(s1);
    expect(entType(s1Ent)).toBe(EntityType.Box);
    const s1Xf = nodeXf(s1);
    expect(mTx(s1Xf)).toBeCloseTo(1, 6); // inverse of position [-1,0,0]

    // unions have no xform; shapes do
    const unionCount =
      (nodeXf(0) === -1 ? 1 : 0) + (nodeXf(c0) === -1 ? 1 : 0);
    const shapeCount =
      (nodeXf(s0) !== -1 ? 1 : 0) +
      (nodeXf(c1) !== -1 ? 1 : 0) +
      (nodeXf(s1) !== -1 ? 1 : 0);
    expect(unionCount).toBe(2);
    expect(shapeCount).toBe(3);

    // entities meta status for those referenced should be >=0
    [0, c0, s0, c1, s1].forEach((nid) => {
      const ei = nodeEnt(nid);
      expect(eMI[ei * el.META_LANES + el.M.STATUS] | 0).toBeGreaterThanOrEqual(0);
    });

    // mats meta status for used transforms should be >=0
    [s0Xf, c1Xf, s1Xf].forEach((xf) => {
      expect(xf).toBeGreaterThanOrEqual(0);
      expect(mMI[xf * ml.META_LANES + ml.M.STATUS] | 0).toBeGreaterThanOrEqual(0);
    });

    // pool validate
    expect(() => nodes.validate()).not.toThrow();
    expect(() => entities.validate()).not.toThrow();
    expect(() => mats.validate()).not.toThrow();
  });
});
