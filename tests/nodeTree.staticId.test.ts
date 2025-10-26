// tests/nodeTree.staticId.test.ts
import { NodeTree } from "../src/pools/nodeTree";
import { views, readNode, collectIdToIndex } from "./testUtils";

describe("NodeTree static IDs", () => {
  test("root owns staticId 0 and idToIndex[0] = 0", () => {
    const nodes = new NodeTree(4);
    const nBV = nodes.getBufferViews();
    const root = readNode(nBV, 0);
    expect(root.staticId).toBe(0);
    expect(nBV.idToIndex[0]).toBe(0);
  });

  test("new children receive sequential static IDs from the initial queue", () => {
    const nodes = new NodeTree(8);
    const a = nodes.addChild(0);
    const b = nodes.addChild(0);
    const c = nodes.addChild(0);

    const nBV = nodes.getBufferViews();
    const sA = readNode(nBV, a).staticId;
    const sB = readNode(nBV, b).staticId;
    const sC = readNode(nBV, c).staticId;

    // Initial queue assigns 1,2,3 (root reserves 0)
    expect([sA, sB, sC]).toEqual([1, 2, 3]);

    // idToIndex maps back
    expect(nBV.idToIndex[sA]).toBe(a);
    expect(nBV.idToIndex[sB]).toBe(b);
    expect(nBV.idToIndex[sC]).toBe(c);
  });

  test("free → enqueue at TAIL; allocate → dequeue from HEAD (FIFO)", () => {
    const nodes = new NodeTree(16);

    const a = nodes.addChild(0);  // SID 1
    const b = nodes.addChild(0);  // SID 2
    const c = nodes.addChild(0);  // SID 3
    const d = nodes.addChild(0);  // SID 4

    // Free b then d. FIFO semantics: freed IDs go to the TAIL.
    nodes.deleteSubtree(b); // enqueue SID 2 at tail
    nodes.deleteSubtree(d); // enqueue SID 4 at tail

    // The free queue still has older free IDs [5..] at the HEAD,
    // so the next allocations pop 5, then 6 (not 2,4).
    const x = nodes.addChild(0);
    const y = nodes.addChild(0);

    const nBV = nodes.getBufferViews();
    const sidX = readNode(nBV, x).staticId;
    const sidY = readNode(nBV, y).staticId;

    expect([sidX, sidY]).toEqual([5, 6]);

    // idToIndex integrity
    const map = collectIdToIndex(nBV);
    expect(map[sidX]).toBe(x);
    expect(map[sidY]).toBe(y);
  });

  test("grow() seeds new static IDs and preserves existing mappings", () => {
    const nodes = new NodeTree(2); // capacity 2 -> SIDs: 0 (root), 1
    const a = nodes.addChild(0);   // consumes SID 1

    // Force growth by allocating many
    const created: number[] = [];
    for (let i = 0; i < 50; i++) created.push(nodes.addChild(0));

    const nBV = nodes.getBufferViews();
    // All live nodes must have valid SIDs mapping back to their indices
    for (let i = 0; i < nodes.size; i++) {
      const sid = readNode(nBV, i).staticId;
      expect(sid).toBeGreaterThanOrEqual(0);
      expect(nBV.idToIndex[sid]).toBe(i);
    }

    // Root still 0 → 0 after growth
    expect(readNode(nBV, 0).staticId).toBe(0);
    expect(nBV.idToIndex[0]).toBe(0);
  });

  test("static ID is cleared on free and returned to the free queue", () => {
    const nodes = new NodeTree(8);
    const a = nodes.addChild(0); // SID 1
    const nBV = nodes.getBufferViews();
    expect(readNode(nBV, a).staticId).toBe(1);
    expect(nBV.idToIndex[1]).toBe(a);

    nodes.deleteSubtree(a);
    const nBV2 = nodes.getBufferViews();

    // After free, the SID mapping becomes negative (encoded link = free node in FIFO)
    const m = nBV2.idToIndex[1] | 0;
    expect(m).toBeLessThan(0);
  });
});
