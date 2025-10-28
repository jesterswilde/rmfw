import { NodeTree } from "../src/pools/nodeTree";
import { Mat34Pool } from "../src/pools/matrix";
import { loadSceneJSON } from "../src/systems/loadSceneJSON"; // adjust path to your parseScene file
import { propagateTransforms } from "../src/systems/propegatTransforms"; // adjust to where your function lives
import { EntityType } from "../src/entityDef";

// --- Mocks: EntityPool + EntityType -------------------------------
// We only need a minimal stub to satisfy parseScene.
jest.mock("../src/pools/entity", () => {
  class EntityPool {
    private _count = 0;
    create(_ent: any, _writeToGPU = false) { return this._count++; }
    validate() {}
    writeAllToGPU() {}
  }
  return { EntityPool };
});


// --- helpers -------------------------------------------------------
const worldPos = (mats: Mat34Pool, id: number) => {
  const t = mats.getWorldTRS(id, "rad");
  return [t.position.x, t.position.y, t.position.z];
};

const epsilonEq = (a: number[], b: number[], eps = 1e-4) =>
  a.length === b.length && a.every((v, i) => Math.abs(v - b[i]!) <= eps);

// little util to pull the first (or only) child id of a node
const firstChild = (nodes: NodeTree, id: number) => {
  const it = nodes.children(id)[Symbol.iterator]();
  const n = it.next();
  return n.done ? -1 : (n.value as number);
};

// --- scenes used in tests -----------------------------------------

// Scene A: root -> sphere (sphere has local xform; root doesn't)
const sceneA = {
  version: 1,
  root: "root",
  nodes: [
    { id: "root", children: ["sphere"], payload: 0 },
    { id: "sphere", payload: 1 },
  ],
  payloads: [
    { type: EntityType.SimpleUnion }, // SimpleUnion
    { type: EntityType.Sphere, position: [1, 2, 3], rotation: [0, 0, 0], radius: 1 }, // Sphere
  ],
};

// Scene B: root -> parent(Box, has xform) -> child(Sphere, has xform)
const sceneB = {
  version: 1,
  root: "root",
  nodes: [
    { id: "root", children: ["parent"], payload: 0 },
    { id: "parent", children: ["child"], payload: 1 },
    { id: "child", payload: 2 },
  ],
  payloads: [
    { type: EntityType.SimpleUnion }, // SimpleUnion
    { type: EntityType.Box, position: [1, 0, 0], rotation: [0, 0, 0], bounds: [1, 1, 1] }, // Box
    { type: EntityType.Sphere, position: [0, 2, 0], rotation: [0, 0, 0], radius: 1 }, // Sphere
  ],
};

// Scene C: root -> parent(Box has xform) -> childNoXform(SimpleUnion, no xform)
const sceneC = {
  version: 1,
  root: "root",
  nodes: [
    { id: "root", children: ["parent"], payload: 0 },
    { id: "parent", children: ["childNoXform"], payload: 1 },
    { id: "childNoXform", payload: 2 },
  ],
  payloads: [
    { type: EntityType.SimpleUnion }, // SimpleUnion
    { type: EntityType.Box, position: [5, 0, 0], rotation: [0, 0, 0], bounds: [1, 1, 1] }, // Box (has xform)
    { type: EntityType.SimpleUnion }, // SimpleUnion (no xform)
  ],
};

// ------------------------------------------------------------------

describe("propagateTransforms", () => {
  it("updates dirty transforms and clears DIRTY; world==local when no parent (Scene A)", () => {
    const nodes = new NodeTree(32);
    const mats = new Mat34Pool(32);

    // parseScene allocates xforms for objects that need them and marks them dirty.
    loadSceneJSON(sceneA as any, nodes, new (require("../src/pools/entity").EntityPool)(), mats, true);

    const sphereNode = firstChild(nodes, /*root*/ 0);
    expect(sphereNode).toBeGreaterThanOrEqual(1);

    const sphereMatId = nodes.getXformIndex(sphereNode);
    expect(sphereMatId).toBeGreaterThan(0);
    expect(mats.isDirty(sphereMatId)).toBe(true);

    const spy = jest.spyOn(mats, "updateWorld");

    // Run
    propagateTransforms(nodes, mats);

    // It should have updated the sphere once
    expect(spy).toHaveBeenCalled();
    expect(mats.isDirty(sphereMatId)).toBe(false);

    // world should equal local because the parent has no xform (-1)
    expect(epsilonEq(worldPos(mats, sphereMatId), [1, 2, 3])).toBe(true);

    // Running again with nothing dirty should do no work
    spy.mockClear();
    propagateTransforms(nodes, mats);
    expect(spy).not.toHaveBeenCalled();
  });

  it("propagates parent dirtiness to children even if child wasn't dirty (Scene B)", () => {
    const nodes = new NodeTree(32);
    const mats = new Mat34Pool(32);

    loadSceneJSON(sceneB as any, nodes, new (require("../src/pools/entity").EntityPool)(), mats, true);

    const parentNode = firstChild(nodes, 0);
    const childNode = firstChild(nodes, parentNode);

    const parentMat = nodes.getXformIndex(parentNode);
    const childMat = nodes.getXformIndex(childNode);

    // Initial pass: both created dirty by parseScene => both updated
    let spy = jest.spyOn(mats, "updateWorld");
    propagateTransforms(nodes, mats);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mats.isDirty(parentMat)).toBe(false);
    expect(mats.isDirty(childMat)).toBe(false);

    // Check initial world positions: parent(1,0,0); child(1,2,0)
    expect(epsilonEq(worldPos(mats, parentMat), [1, 0, 0])).toBe(true);
    expect(epsilonEq(worldPos(mats, childMat), [1, 2, 0])).toBe(true);

    // Change ONLY the parent local transform => marks parent dirty
    mats.addTranslation(parentMat, { x: 10, y: 0, z: 0 } as any, false);
    expect(mats.isDirty(parentMat)).toBe(true);
    expect(mats.isDirty(childMat)).toBe(false); // child not dirty

    // Because parent is dirty, propagateTransforms should recompute BOTH parent and child worlds.
    spy.mockClear();
    propagateTransforms(nodes, mats);

    // Expect two updates (parent, child)
    // Note: could be >=2 if implementation ever updates additional xforms
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(mats.isDirty(parentMat)).toBe(false);
    expect(mats.isDirty(childMat)).toBe(false);

    // New world positions: parent(11,0,0), child(11,2,0)
    expect(epsilonEq(worldPos(mats, parentMat), [11, 0, 0])).toBe(true);
    expect(epsilonEq(worldPos(mats, childMat), [11, 2, 0])).toBe(true);
  });

  it("does not call updateWorld for nodes without transforms; still descends (Scene C)", () => {
    const nodes = new NodeTree(32);
    const mats = new Mat34Pool(32);

    loadSceneJSON(sceneC as any, nodes, new (require("../src/pools/entity").EntityPool)(), mats, true);

    const parentNode = firstChild(nodes, 0);
    const childNode = firstChild(nodes, parentNode);

    const parentMat = nodes.getXformIndex(parentNode);
    const childMat = nodes.getXformIndex(childNode);

    expect(parentMat).toBeGreaterThan(0);
    expect(childMat).toBe(-1); // child has no xform by design

    const spy = jest.spyOn(mats, "updateWorld");

    propagateTransforms(nodes, mats);

    // Should update only the parent (>=1 call) but never pass -1 child id
    expect(spy).toHaveBeenCalled();
    // Verify there's no call where first arg equals -1 (mats.updateWorld(id,...))
    expect(spy.mock.calls.find(call => call[0] === -1)).toBeUndefined();
  });

  it("handles deep trees without throwing and keeps DIRTY depth bookkeeping correct", () => {
    // Build: root -> a(Box) -> b(Box) -> c(Sphere)
    const deepScene = {
      version: 1,
      root: "root",
      nodes: [
        { id: "root", children: ["a"], payload: 0 },
        { id: "a", children: ["b"], payload: 1 },
        { id: "b", children: ["c"], payload: 2 },
        { id: "c", payload: 3 },
      ],
      payloads: [
        { type: EntityType.SimpleUnion }, // SimpleUnion
        { type: 2, position: [1, 0, 0], rotation: [0, 0, 0], bounds: [1, 1, 1] }, // Box
        { type: 2, position: [0, 3, 0], rotation: [0, 0, 0], bounds: [1, 1, 1] }, // Box
        { type: 1, position: [0, 0, 4], rotation: [0, 0, 0], radius: 1 }, // Sphere
      ],
    };

    const nodes = new NodeTree(64);
    const mats = new Mat34Pool(64);
    loadSceneJSON(deepScene as any, nodes, new (require("../src/pools/entity").EntityPool)(), mats, true);

    const a = firstChild(nodes, 0);
    const b = firstChild(nodes, a);
    const c = firstChild(nodes, b);

    const aMat = nodes.getXformIndex(a);
    const bMat = nodes.getXformIndex(b);
    const cMat = nodes.getXformIndex(c);

    // Initial pass updates all three xforms
    propagateTransforms(nodes, mats);

    // Expect world pos for c to be the composition: [1,3,4]
    expect(epsilonEq(worldPos(mats, cMat), [1, 3, 4])).toBe(true);

    // Now nudge 'a' only; 'b' and 'c' should recompute via dirtyDepth
    mats.addTranslation(aMat, { x: -2, y: 0, z: 0 } as any, false);

    const spy = jest.spyOn(mats, "updateWorld").mockClear();
    propagateTransforms(nodes, mats);

    expect(mats.isDirty(aMat)).toBe(false);
    expect(mats.isDirty(bMat)).toBe(false);
    expect(mats.isDirty(cMat)).toBe(false);

    // New world for c: [-1,3,4]
    expect(epsilonEq(worldPos(mats, cMat), [-1, 3, 4])).toBe(true);

    // Should have updated at least a, b, c
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
