import { NodeTree } from '../src/pools/nodeTree';

const GPU_LANES = NodeTree.Layout.GPU_LANES;   // [index, child, sib, flags]
const META_LANES = NodeTree.Layout.META_LANES;  // [parent, status, xform_id]
const M_STATUS = NodeTree.Layout.M.STATUS;
const SENTINEL = -1;

const ids = (it: Iterable<number>) => Array.from(it);

const makeSmall = () => new NodeTree(8);

describe('nodeTree', () => {
  test('initializes with root only', () => {
    const t = makeSmall();
    expect(t.size).toBe(1);
    expect(t.root).toBe(0);
    const snap = t.snapshot(0);
    expect(snap.parent).toBe(-1);
    expect(snap.child).toBe(-1);
    expect(snap.sibling).toBe(-1);
    expect(snap.flags).toBe(0);
    expect(t.getXformIndex(0)).toBe(-1);
  });

  test('add children inserts at head and near parent', () => {
    const t = makeSmall();
    const a = t.addChild(t.root, 0xA, 11, 100);
    const b = t.addChild(t.root, 0xB, 22, 200);
    expect(t.size).toBe(3);

    const kids = ids(t.children(t.root));
    expect(kids).toEqual([b, a]); // head insert (LIFO)

    expect(t.getFlags(a)).toBe(0xA);
    expect(t.getFlags(b)).toBe(0xB);
    expect(t.getEntityIndex(a)).toBe(11);
    expect(t.getEntityIndex(b)).toBe(22);
    expect(t.getXformIndex(a)).toBe(100);
    expect(t.getXformIndex(b)).toBe(200);
  });

  test('delete subtree (non-root) detaches correctly', () => {
    const t = makeSmall();
    const a = t.addChild(t.root, 1, 0, 10);
    const b = t.addChild(t.root, 2, 0, 20);
    const a1 = t.addChild(a, 3, 0, 30);
    const a2 = t.addChild(a, 4, 0, 40);
    const b1 = t.addChild(b, 5, 0, 50);

    expect(t.size).toBe(1 + 2 + 3); // root + (a,b) + (a1,a2,b1)

    t.deleteSubtree(a);

    expect(t.size).toBe(1 + 1 + 1); // root + b + b1
    expect(ids(t.children(t.root))).toEqual([b]); // a removed
    expect(ids(t.children(b))).toEqual([b1]);

    expect(() => t.getFlags(a)).toThrow();  // freed
    expect(() => t.getFlags(a1)).toThrow();
    expect(() => t.getFlags(a2)).toThrow();
    expect(() => t.getXformIndex(a)).toThrow();  // freed
    expect(() => t.getXformIndex(a1)).toThrow();
    expect(() => t.getXformIndex(a2)).toThrow();
  });

  test('delete root clears all children but keeps root', () => {
    const t = makeSmall();
    const a = t.addChild(0, 1, 0, 10);
    const b = t.addChild(0, 2, 0, 20);
    const a1 = t.addChild(a, 3, 0, 30);
    expect(t.size).toBe(4);

    t.deleteSubtree(0);

    expect(t.size).toBe(1);
    expect(ids(t.children(0))).toEqual([]);
    expect(() => t.getFlags(a)).toThrow();
    expect(() => t.getFlags(a1)).toThrow();
    expect(() => t.getFlags(b)).toThrow();
    expect(() => t.getXformIndex(a)).toThrow();
    expect(() => t.getXformIndex(a1)).toThrow();
    expect(() => t.getXformIndex(b)).toThrow();
    expect(t.snapshot(0).parent).toBe(-1);
  });

  test('setFlags / getFlags and entity index', () => {
    const t = makeSmall();
    const a = t.addChild(0, 0, 7, 100);
    expect(t.getEntityIndex(a)).toBe(7);
    expect(t.getXformIndex(a)).toBe(100);
    t.setEntityIndex(a, 1234);
    t.setFlags(a, 0xFEEDFACE >>> 0);
    t.setXformIndex(a, 200);
    expect(t.getEntityIndex(a)).toBe(1234);
    expect(t.getFlags(a)).toBe(0xFEEDFACE >>> 0);
    expect(t.getXformIndex(a)).toBe(200);
  });

  test('children iterator yields full sibling chain', () => {
    const t = makeSmall();
    const a = t.addChild(0, 0, 0, 10);
    const b = t.addChild(0, 0, 0, 20);
    const c = t.addChild(0, 0, 0, 30);
    expect(ids(t.children(0))).toEqual([c, b, a]);
    expect(t.getXformIndex(a)).toBe(10);
    expect(t.getXformIndex(b)).toBe(20);
    expect(t.getXformIndex(c)).toBe(30);
  });

  test('resizing (grow) preserves data and continues allocating', () => {
    const t = new NodeTree(2); // root + 1 free
    const a = t.addChild(0, 1, 0, 10);
    const b = t.addChild(0, 2, 0, 20); // triggers grow
    const c = t.addChild(a, 3, 0, 30);
    const d = t.addChild(b, 4, 0, 40);

    expect(t.capacity).toBeGreaterThanOrEqual(4);
    expect(t.size).toBe(5);
    expect(ids(t.children(0)).length).toBe(2);
    expect(ids(t.children(a))).toEqual([c]);
    expect(ids(t.children(b))).toEqual([d]);

    expect(t.getFlags(a)).toBe(1);
    expect(t.getFlags(b)).toBe(2);
    expect(t.getFlags(c)).toBe(3);
    expect(t.getFlags(d)).toBe(4);
    expect(t.getXformIndex(a)).toBe(10);
    expect(t.getXformIndex(b)).toBe(20);
    expect(t.getXformIndex(c)).toBe(30);
    expect(t.getXformIndex(d)).toBe(40);
  });

  test('operations on non-alive ids throw', () => {
    const t = makeSmall();
    expect(() => t.addChild(-1)).toThrow();
    expect(() => t.setFlags(-1, 1)).toThrow();
    expect(() => t.getXformIndex(-1)).toThrow();

    const a = t.addChild(0, 1, 0, 10);
    t.deleteSubtree(a);
    expect(() => t.setFlags(a, 2)).toThrow();
    expect(() => t.getXformIndex(a)).toThrow();
    expect(() => ids(t.children(a))).toThrow();
  });

  test('buffer views look sane', () => {
    const t = makeSmall();
    const v = t.getBufferViews();

    // GPU mirror buffer
    expect(v.gpuMirrorBuffer.byteLength).toBe(t.capacity * GPU_LANES * 4);
    expect(v.GPU_STRIDE).toBe(GPU_LANES);
    expect(v.gpuI32.buffer).toBe(v.gpuMirrorBuffer);
    expect(v.gpuU32.buffer).toBe(v.gpuMirrorBuffer);

    // Meta buffer
    expect(v.metaBuffer.byteLength).toBe(t.capacity * META_LANES * 4);
    expect(v.META_STRIDE).toBe(META_LANES);
    expect(v.metaI32.buffer).toBe(v.metaBuffer);
  });

  test('free-list reuse after delete (new child reuses freed slot)', () => {
    const t = makeSmall();
    const a = t.addChild(0, 0, 0, 10);
    const b = t.addChild(0, 0, 0, 20);
    t.deleteSubtree(b);
    const c = t.addChild(0, 0, 0, 30);
    const kids = ids(t.children(0));
    expect(kids[0]).toBe(c); // head insert
    expect(t.size).toBe(1 + 2); // root + a + c
    expect(t.getXformIndex(a)).toBe(10);
    expect(t.getXformIndex(c)).toBe(30);
  });

  test('deep subtree delete frees all descendants', () => {
    const t = makeSmall();
    const a = t.addChild(0, 0, 0, 10);
    const a1 = t.addChild(a, 0, 0, 20);
    const a2 = t.addChild(a, 0, 0, 30);
    const a21 = t.addChild(a2, 0, 0, 40);
    const a22 = t.addChild(a2, 0, 0, 50);
    expect(t.size).toBe(1 + 5);
    t.deleteSubtree(a2);
    expect(t.size).toBe(1 + 2); // root + a + a1
    expect(ids(t.children(a))).toEqual([a1]);
    expect(() => t.snapshot(a21)).toThrow();
    expect(() => t.snapshot(a22)).toThrow();
    expect(() => t.getXformIndex(a21)).toThrow();
    expect(() => t.getXformIndex(a22)).toThrow();
  });

  test('xform ID functionality', () => {
    const t = makeSmall();
    
    // Test default xform ID (-1)
    const a = t.addChild(0, 0, 0); // no xform ID specified
    expect(t.getXformIndex(a)).toBe(-1);
    
    // Test setting xform ID
    t.setXformIndex(a, 100);
    expect(t.getXformIndex(a)).toBe(100);
    
    // Test creating with xform ID
    const b = t.addChild(0, 0, 0, 200);
    expect(t.getXformIndex(b)).toBe(200);
    
    // Test updating xform ID
    t.setXformIndex(b, 300);
    expect(t.getXformIndex(b)).toBe(300);
    
    // Test operations on invalid IDs throw
    expect(() => t.setXformIndex(-1, 100)).toThrow();
    expect(() => t.getXformIndex(-1)).toThrow();
  });
});
