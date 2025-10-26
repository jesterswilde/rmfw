// tests/testUtils.ts
import { NodeTree } from "../src/pools/nodeTree";
import { EntityPool } from "../src/pools/entity";
import { Mat34Pool } from "../src/pools/matrix";

export type NV = ReturnType<NodeTree["getBufferViews"]>;
export type EV = ReturnType<EntityPool["getBufferViews"]>;
export type MV = ReturnType<Mat34Pool["getBufferViews"]>;

export const views = (nodes: NodeTree, ents?: EntityPool, mats?: Mat34Pool) => ({
  n: nodes.getBufferViews(),
  e: ents ? ents.getBufferViews() : undefined,
  m: mats ? mats.getBufferViews() : undefined,
});

export const readNode = (nBV: NV, i: number) => {
  const nl = (NodeTree as any).Layout;
  const gi = i * nl.GPU_LANES;
  const mi = i * nl.META_LANES;
  return {
    idx: i,
    entityIndex: nBV.gpuI32[gi + nl.G.ENTITY_INDEX] | 0,
    child:       nBV.gpuI32[gi + nl.G.CHILD] | 0,
    sib:         nBV.gpuI32[gi + nl.G.SIB] | 0,
    flags:       nBV.gpuU32[gi + nl.G.FLAGS] >>> 0,
    parent:      nBV.metaI32[mi + nl.M.PARENT] | 0,
    status:      nBV.metaI32[mi + nl.M.STATUS] | 0,
    xform:       nBV.metaI32[mi + nl.M.XFORM_INDEX] | 0,
    staticId:    nBV.metaI32[mi + nl.M.STATIC_ID] | 0,
  };
};

export const snapshotBuffers = (nodes: NodeTree, ents: EntityPool, mats: Mat34Pool) => {
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

/** Encoded free next pointer format check: value < 0 and not equal to -2 */
export const expectEncodedFree = (v: number) => {
  expect(v).toBeLessThan(0);
  expect(v).not.toBe(-2);
};

/** Convenience: return id->index mapping for all LIVE static IDs */
export const collectIdToIndex = (nBV: NV) => {
  const map = nBV.idToIndex;
  const out: Record<number, number> = {};
  for (let sid = 0; sid < map.length; sid++) {
    const val = map[sid] | 0;
    if (val >= 0) out[sid] = val;
  }
  return out;
};
