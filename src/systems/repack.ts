import { EntityPool } from "../pools/entity.js";
import { Mat34Pool } from "../pools/matrix.js";
import { NodeTree } from "../pools/nodeTree.js";

export const repack = (nodes: NodeTree, entities: EntityPool, mats: Mat34Pool) => {
  const nl = NodeTree.Layout;
  const el = EntityPool.Layout;
  const ml = Mat34Pool.Layout;

  const nBV = nodes.getBufferViews();
  const eBV = entities.getBufferViews();
  const mBV = mats.getBufferViews();

  const iOldNodeGI = new Int32Array(nBV.gpuMirrorBuffer);
  const iOldEntGI  = new Int32Array(eBV.gpuMirrorBuffer);
  const fOldMatGF  = new Float32Array(mBV.gpuMirrorBuffer);

  const iOldNodeMI = new Int32Array(nBV.metaBuffer);
  const iOldEntMI  = new Int32Array(eBV.metaBuffer);
  const iOldMatMI  = new Int32Array(mBV.metaBuffer);

  const newNodeGBuffer = new ArrayBuffer(nBV.gpuMirrorBuffer.byteLength);
  const newNodeMBuffer = new ArrayBuffer(nBV.metaBuffer.byteLength);
  const newEntGBuffer  = new ArrayBuffer(eBV.gpuMirrorBuffer.byteLength);
  const newEntMBuffer  = new ArrayBuffer(eBV.metaBuffer.byteLength);
  const newMatGBuffer  = new ArrayBuffer(mBV.gpuMirrorBuffer.byteLength);
  const newMatMBuffer  = new ArrayBuffer(mBV.metaBuffer.byteLength);

  const iNewNodeGI = new Int32Array(newNodeGBuffer);
  const iNewNodeMI = new Int32Array(newNodeMBuffer);
  const iNewEntGI  = new Int32Array(newEntGBuffer);
  const iNewEntMI  = new Int32Array(newEntMBuffer);
  const fNewMatGF  = new Float32Array(newMatGBuffer);
  const iNewMatMI  = new Int32Array(newMatMBuffer);

  const encodeNextFree = (nextId: number) => -2 - (nextId === -1 ? -1 : nextId);
  const isNodeAlive = (id: number) =>
    id >= 0 && id < nodes.capacity && (iOldNodeMI[id * nl.META_LANES + nl.M.STATUS]! | 0) >= 0;

  // DFS order
  if (!isNodeAlive(0)) throw new Error("repack: root not alive");
  const order: number[] = [];
  const stack: number[] = [0];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!isNodeAlive(cur)) continue;
    order.push(cur);
    const kids: number[] = [];
    for (let c = iOldNodeGI[cur * nl.GPU_LANES + nl.G.CHILD]! | 0;
         c !== -1;
         c = iOldNodeGI[c * nl.GPU_LANES + nl.G.SIB]! | 0) {
      if (isNodeAlive(c)) kids.push(c);
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
  }

  const liveCount = order.length;
  const oldToNewNode = new Int32Array(nodes.capacity).fill(-1);
  for (let i = 0; i < liveCount; i++) oldToNewNode[order[i]!] = i;
  const remapNode = (oldId: number) => (oldId === -1 ? -1 : oldToNewNode[oldId]!);

  // Transform remap
  const xformMap = new Int32Array(mats.capacity).fill(-1);
  let xformCount = 0;
  const mapXform = (oldX: number): number => {
    if (oldX < 0) return -1;
    const cached = xformMap[oldX]! | 0;
    if (cached >= 0) return cached;
    const src = oldX * ml.GPU_LANES, dst = xformCount * ml.GPU_LANES;
    for (let k = 0; k < ml.GPU_LANES; k++) fNewMatGF[dst + k] = fOldMatGF[src + k]!;
    iNewMatMI[xformCount * ml.META_LANES + ml.M.STATUS] = xformCount;
    xformMap[oldX] = xformCount;
    return xformCount++;
  };

  // Copy nodes/entities, remap xforms
  for (let nNew = 0; nNew < liveCount; nNew++) {
    const nOld = order[nNew]!;
    const nOGI = nOld * nl.GPU_LANES, nOMI = nOld * nl.META_LANES;
    const nNGI = nNew * nl.GPU_LANES, nNMI = nNew * nl.META_LANES;

    iNewNodeGI[nNGI + nl.G.FLAGS] = iOldNodeGI[nOGI + nl.G.FLAGS]!;
    iNewNodeGI[nNGI + nl.G.ENTITY_INDEX] = 0;
    iNewNodeGI[nNGI + nl.G.CHILD] = -1;
    iNewNodeGI[nNGI + nl.G.SIB] = -1;

    iNewNodeMI[nNMI + nl.M.PARENT] = -1;
    iNewNodeMI[nNMI + nl.M.STATUS] = nNew;
    iNewNodeMI[nNMI + nl.M.XFORM_INDEX] = mapXform(iOldNodeMI[nOMI + nl.M.XFORM_INDEX]! | 0);
    iNewNodeMI[nNMI + nl.M.STATIC_ID] = iOldNodeMI[nOMI + nl.M.STATIC_ID]!;


    const eOld = iOldNodeGI[nOGI + nl.G.ENTITY_INDEX]! | 0;
    const eOGI = eOld * el.GPU_LANES, eNGI = nNew * el.GPU_LANES;
    for (let k = 0; k < el.GPU_LANES; k++) iNewEntGI[eNGI + k] = iOldEntGI[eOGI + k]!;

    const oldEntX = iNewEntGI[eNGI + el.G.H_XFORM]! | 0;
    iNewEntGI[eNGI + el.G.H_XFORM] = oldEntX >= 0 ? (xformMap[oldEntX]! | 0) : -1;
    iNewEntMI[nNew * el.META_LANES + el.M.STATUS] = nNew;

    iNewNodeGI[nNGI + nl.G.ENTITY_INDEX] = nNew;
  }

  // Remap links
  for (let nNew = 0; nNew < liveCount; nNew++) {
    const nOld = order[nNew]!;
    const nOGI = nOld * nl.GPU_LANES, nOMI = nOld * nl.META_LANES;
    const nNGI = nNew * nl.GPU_LANES, nNMI = nNew * nl.META_LANES;
    iNewNodeMI[nNMI + nl.M.PARENT] = remapNode(iOldNodeMI[nOMI + nl.M.PARENT]! | 0);
    iNewNodeGI[nNGI + nl.G.CHILD]  = remapNode(iOldNodeGI[nOGI + nl.G.CHILD]! | 0);
    iNewNodeGI[nNGI + nl.G.SIB]    = remapNode(iOldNodeGI[nOGI + nl.G.SIB]! | 0);
  }

  // Free lists
  let nodeFree = -1;
  for (let id = nodes.capacity - 1; id >= liveCount; id--) {
    iNewNodeMI[id * nl.META_LANES + nl.M.STATUS] = encodeNextFree(nodeFree);
    nodeFree = id;
  }
  nodes.replaceBuffers(newNodeGBuffer, newNodeMBuffer, liveCount, nodeFree);

  let entFree = -1;
  for (let id = entities.capacity - 1; id >= liveCount; id--) {
    iNewEntMI[id * el.META_LANES + el.M.STATUS] = encodeNextFree(entFree);
    entFree = id;
  }
  entities.replaceBuffers(newEntGBuffer, newEntMBuffer, liveCount, entFree);

  let matFree = -1;
  for (let id = mats.capacity - 1; id >= xformCount; id--) {
    iNewMatMI[id * ml.META_LANES + ml.M.STATUS] = encodeNextFree(matFree);
    matFree = id;
  }
  mats.replaceBuffers(newMatGBuffer, newMatMBuffer, xformCount, matFree);
};
