import { ShapePool } from "../pools/entity.js";
import { Mat34Pool } from "../pools/matrix.js";
import { NodeTree } from "../pools/nodeTree.js";
import { ShapeType, type Shapes } from "../entityDef.js";
import { Vector3, type EulerZYX } from "../utils/math.js";
import { propagateTransforms } from "./propegatTransforms.js";

const toEulerZYX = (r: number[]): EulerZYX => ({
  yawZ: r?.[0] ?? 0,
  pitchY: r?.[1] ?? 0,
  rollX: r?.[2] ?? 0,
  units: "rad",
});

const needsXform = (t: number) =>
  t === ShapeType.Sphere ||
  t === ShapeType.Box ||
  t === ShapeType.Camera ||
  t === ShapeType.GateBox;

function makeEntity(payload: any, xformId: number): Shapes {
  const t = (payload?.type ?? -1) as number;

  if (t === ShapeType.Sphere) {
    return {
      type: ShapeType.Sphere,
      xformID: xformId,
      material: payload.material ?? undefined,
      radius: payload.radius ?? 0,
    };
  }
  if (t === ShapeType.Box) {
    const b = payload.bounds ?? [0, 0, 0];
    return {
      type: ShapeType.Box,
      xformID: xformId,
      material: payload.material ?? undefined,
      bounds: new Vector3(b[0], b[1], b[2]),
    };
  }
  if (t === ShapeType.Camera) {
    return { type: ShapeType.Camera, xformID: xformId };
  }
  if (t === ShapeType.GateBox) {
    const b = payload.bounds ?? [0, 0, 0];
    return { type: ShapeType.GateBox, xformID: xformId, bounds: new Vector3(b[0], b[1], b[2]) };
  }
  if (t === ShapeType.ReduceUnion)      return { type: ShapeType.ReduceUnion, children: payload.children ?? 0 };
  if (t === ShapeType.SimpleUnion)      return { type: ShapeType.SimpleUnion };
  if (t === ShapeType.SimpleSubtract)   return { type: ShapeType.SimpleSubtract };
  if (t === ShapeType.SimpleIntersection) return { type: ShapeType.SimpleIntersection };

  throw new Error(`scene parse: unsupported payload type ${t}`);
}

/** parses a scene object and inserts the data in to pool objects,
 * returns number of objects in the scene.
 */
export function parseScene(obj: any, nodes: NodeTree, entities: ShapePool, mats: Mat34Pool): number {
  // validate
  if (!obj || obj.version !== 1) throw new Error("scene parse: bad or missing version");
  if (!obj.root) throw new Error("scene parse: missing root id");
  if (!Array.isArray(obj.nodes) || !Array.isArray(obj.payloads))
    throw new Error("scene parse: nodes/payloads must be arrays");

  const nodeById = new Map<string, any>();
  for (const n of obj.nodes) {
    if (!n?.id) throw new Error("scene parse: node missing id");
    nodeById.set(n.id, n);
  }
  if (!nodeById.has(obj.root)) throw new Error(`scene parse: unknown root '${obj.root}'`);

  // precompute transforms
  const xformIdByNodeId = new Map<string, number>();
  for (const n of obj.nodes) {
    const p = obj.payloads[n.payload];
    if (p == null) throw new Error(`scene parse: node '${n.id}' has invalid payload index ${n.payload}`);
    const t = (p.type ?? -1) as number;

    if (needsXform(t)) {
      const pos = p.position ?? [0, 0, 0];
      const rot = p.rotation ?? [0, 0, 0];
      const xformId = mats.create(true, false);
      mats.setFromTRS(xformId, new Vector3(pos[0], pos[1], pos[2]), toEulerZYX(rot), false);
      xformIdByNodeId.set(n.id, xformId);
    } else {
      xformIdByNodeId.set(n.id, -1);
    }
  }

  // create entities
  const entIdByNodeId = new Map<string, number>();
  for (const n of obj.nodes) {
    const p = obj.payloads[n.payload];
    const xformId = xformIdByNodeId.get(n.id)!;
    const ent = makeEntity(p, xformId);
    const eid = entities.create(ent, false);
    entIdByNodeId.set(n.id, eid);
  }

  // build node tree
  nodes.setEntityIndex(0, entIdByNodeId.get(obj.root)!, false);
  nodes.setXformIndex(0, xformIdByNodeId.get(obj.root) ?? -1);

  const nodeIndexById = new Map<string, number>();
  nodeIndexById.set(obj.root, 0);

  const stack: string[] = [obj.root];
  while (stack.length) {
    const pid = stack.pop()!;
    const pNode = nodeById.get(pid)!;
    const pIdx = nodeIndexById.get(pid)!;
    const kids: string[] = pNode.children ?? [];

    // preserve order (addChild inserts at head)
    for (let i = kids.length - 1; i >= 0; i--) {
      const cid = kids[i]!;
      const cNode = nodeById.get(cid);
      if (!cNode) throw new Error(`scene parse: unknown child '${cid}' of '${pid}'`);
      const eIdx = entIdByNodeId.get(cid)!;
      const xIdx = xformIdByNodeId.get(cid) ?? -1;
      const nIdx = nodes.addChild(pIdx, 0, eIdx, xIdx, false);
      nodeIndexById.set(cid, nIdx);
      stack.push(cid);
    }
  }

  // validate
  nodes.validate();
  entities.validate();
  mats.validate();

  nodes.writeAllToGPU();
  entities.writeAllToGPU();

  return obj.nodes.length
}
