// tests/ecs/hierarchyDetection.test.ts
import { defineMeta, World } from "../../src/ecs/core";
import { initWorld } from "../../src/ecs/registry";
import { buildAllHierarchyTrees, isHierarchyStore } from "../../src/ecs/trees";

describe("Hierarchy store detection", () => {
  test("isHierarchyStore only accepts Int32 link fields", () => {
    const goodMeta = defineMeta({
      name: "GoodNode",
      fields: [
        { key: "parent", ctor: Int32Array, default: -1, link: true },
        { key: "firstChild", ctor: Int32Array, default: -1, link: true },
        { key: "nextSibling", ctor: Int32Array, default: -1, link: true },
      ] as const,
    });

    const badMeta = defineMeta({
      name: "BadNode",
      fields: [
        { key: "parent", ctor: Int32Array, default: -1 }, // missing link flag
        { key: "firstChild", ctor: Float32Array, default: -1, link: true }, // wrong ctor
        { key: "nextSibling", ctor: Int32Array, default: -1, link: true },
      ] as const,
    });

    const world = new World({ initialCapacity: 8 });
    const goodStore = world.register({ meta: goodMeta }, 8);
    const badStore = world.register({ meta: badMeta }, 8);

    expect(isHierarchyStore(goodStore)).toBe(true);
    expect(isHierarchyStore(badStore)).toBe(false);
  });

  test("buildAllHierarchyTrees discovers all eligible stores", () => {
    const world = initWorld({ initialCapacity: 8 });

    const extraMeta = defineMeta({
      name: "AuxNode",
      fields: [
        { key: "parent", ctor: Int32Array, default: -1, link: true },
        { key: "firstChild", ctor: Int32Array, default: -1, link: true },
        { key: "nextSibling", ctor: Int32Array, default: -1, link: true },
      ] as const,
    });

    world.register({ meta: extraMeta }, 8);

    // Hide built-in listing to exercise __forEachStore fallback.
    (world as any).__listStoreNames = () => [];

    const trees = buildAllHierarchyTrees(world);
    expect(Array.from(trees.keys()).sort()).toEqual([
      "AuxNode",
      "RenderNode",
      "TransformNode",
    ]);

    const auxTree = trees.get("AuxNode");
    expect(auxTree).toBeDefined();
    expect(auxTree?.componentName).toBe("AuxNode");
  });
});
