import { World, NONE } from "../../src/ecs/core/index.js";
import { saveScene, type RmfwSceneV1 } from "../../src/ecs/save.js";
import { loadScene } from "../../src/ecs/load.js";
import {
  Transform,
  TransformNode,
  RenderNode,
  ShapeLeaf,
  Operation,
} from "../../src/ecs/registry.js";

const rebuildCalls: Array<{ name: string; hints?: number[] }> = [];

jest.mock("../../src/ecs/tree/tree.js", () => {
  const actual = jest.requireActual("../../src/ecs/tree/tree.js");
  return {
    ...actual,
    buildAllHierarchyTrees: (_world: unknown) => {
      const map = new Map<string, { rebuildOrder: (hints?: number[]) => void }>();
      for (const name of [TransformNode.meta.name, RenderNode.meta.name]) {
        map.set(name, {
          rebuildOrder: (hints?: number[]) => {
            rebuildCalls.push({ name, hints: hints ? [...hints] : undefined });
          },
        });
      }
      return map;
    },
  };
});

const nodeDefaults = {
  parent: NONE,
  firstChild: NONE,
  lastChild: NONE,
  nextSibling: NONE,
  prevSibling: NONE,
};

beforeEach(() => {
  rebuildCalls.length = 0;
});

type RegisteredStores = {
  transform: ReturnType<World["register"]>;
  transformNode: ReturnType<World["register"]>;
  renderNode: ReturnType<World["register"]>;
  shape: ReturnType<World["register"]>;
  operation: ReturnType<World["register"]>;
};

function registerAll(world: World): RegisteredStores {
  return {
    transform: world.register(Transform, 4),
    transformNode: world.register(TransformNode, 4),
    renderNode: world.register(RenderNode, 4),
    shape: world.register(ShapeLeaf, 4),
    operation: world.register(Operation, 4),
  } as RegisteredStores;
}

function populateWorld(world: World) {
  const stores = registerAll(world);
  const root = world.createEntity();
  const child = world.createEntity();
  const leaf = world.createEntity();

  stores.transform.add(root, { world_tx: 1, world_ty: 0, world_tz: 3 });
  stores.transform.add(child, { world_tx: 4, world_ty: 0, world_tz: 6 });
  stores.transform.add(leaf, { world_tx: 7, world_ty: 0, world_tz: 9 });

  stores.transformNode.add(root, { ...nodeDefaults, firstChild: child, lastChild: child });
  stores.transformNode.add(child, { ...nodeDefaults, parent: root, firstChild: leaf, lastChild: leaf });
  stores.transformNode.add(leaf, { ...nodeDefaults, parent: child });

  stores.renderNode.add(root, { ...nodeDefaults, firstChild: child, lastChild: child });
  stores.renderNode.add(child, { ...nodeDefaults, parent: root });

  stores.shape.add(leaf, { shapeType: 1, p0: 0.5, p1: 0.25, p2: 0, p3: 0, p4: 0, p5: 0 });
  stores.operation.add(root, { opType: 0 });
  stores.operation.add(child, { opType: 1 });

  return { world, stores, entities: { root, child, leaf } };
}

describe("saveScene", () => {
  it("saves populated worlds with presence masks and remapped links", () => {
    const { world } = populateWorld(new World({ initialCapacity: 8 }));
    const scene = saveScene(world);

    expect(scene.entityCount).toBe(3);
    const byName = new Map(scene.components.map((c) => [c.name, c]));
    const transformNode = byName.get(TransformNode.meta.name)!;
    const shape = byName.get(ShapeLeaf.meta.name)!;

    expect(transformNode.present).toEqual([1, 1, 1]);
    expect(shape.present).toEqual([0, 0, 1]);

    const parentColumn = transformNode.columns![transformNode.fieldOrder!.indexOf("parent")!];
    expect(parentColumn).toEqual([NONE, 0, 1]);

    const transform = byName.get(Transform.meta.name)!;
    const worldTxColumn = transform.columns![transform.fieldOrder!.indexOf("world_tx")!];
    expect(worldTxColumn).toEqual([1, 4, 7]);
    const worldTzColumn = transform.columns![transform.fieldOrder!.indexOf("world_tz")!];
    expect(worldTzColumn).toEqual([3, 6, 9]);

    expect(scene.components.find((c) => c.name === RenderNode.meta.name)).toBeDefined();
    expect(scene.components.find((c) => c.name === Operation.meta.name)?.present).toEqual([1, 1, 0]);
  });

  it("drops all-default columns when requested", () => {
    const { world } = populateWorld(new World({ initialCapacity: 8 }));
    const scene = saveScene(world, { dropDefaultColumns: true });
    const transform = scene.components.find((c) => c.name === Transform.meta.name)!;

    expect(transform.fieldOrder).toContain("world_tx");
    expect(transform.fieldOrder).not.toContain("world_ty");
    expect(transform.fieldOrder).not.toContain("local_r00");
  });

  it("includes root hints when requested", () => {
    const { world } = populateWorld(new World({ initialCapacity: 8 }));
    const scene = saveScene(world, { includeRoots: true });

    expect(scene.roots?.transform).toEqual([0]);
    expect(scene.roots?.render).toEqual([0]);
  });

  it("saves empty worlds without component blocks", () => {
    const world = new World({ initialCapacity: 2 });
    registerAll(world);
    const scene = saveScene(world);
    expect(scene.entityCount).toBe(0);
    expect(scene.components).toHaveLength(0);
  });

  it("omits missing component metas without throwing", () => {
    const world = new World({ initialCapacity: 2 });
    world.register(Transform, 2);
    expect(() => saveScene(world)).not.toThrow();
    const scene = saveScene(world);
    expect(scene.components.every((c) => c.name === Transform.meta.name)).toBe(true);
  });
});

describe("loadScene", () => {
  it("recreates entities and component rows", () => {
    const { world } = populateWorld(new World({ initialCapacity: 8 }));
    const scene = saveScene(world);

    const targetWorld = new World({ initialCapacity: 1 });
    const stores = registerAll(targetWorld);
    const summary = loadScene(targetWorld, scene);

    expect(summary.entityCount).toBe(scene.entityCount);
    expect(targetWorld.entities.size).toBe(scene.entityCount);

    for (const entity of [0, 1, 2]) {
      expect(stores.transform.has(entity)).toBe(true);
      expect(stores.transformNode.has(entity)).toBe(true);
    }

    const tf = stores.transform.fields();
    const rowLeaf = stores.transform.denseIndexOf(2);
    expect(tf.world_tx[rowLeaf]).toBeCloseTo(7);
    expect(tf.world_tz[rowLeaf]).toBeCloseTo(9);

    const nodeCols = stores.transformNode.fields();
    expect(nodeCols.parent[stores.transformNode.denseIndexOf(0)]).toBe(NONE);
    expect(nodeCols.parent[stores.transformNode.denseIndexOf(1)]).toBe(0);
    expect(nodeCols.parent[stores.transformNode.denseIndexOf(2)]).toBe(1);
  });

  it("fills defaults when columns are omitted", () => {
    const world = new World({ initialCapacity: 2 });
    const stores = registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 2,
      components: [
        { name: Transform.meta.name, present: [1, 1] },
      ],
    };

    loadScene(world, scene);

    const tf = stores.transform.fields();
    expect(tf.local_r00[stores.transform.denseIndexOf(0)]).toBe(1);
    expect(tf.local_r11[stores.transform.denseIndexOf(1)]).toBe(1);
    expect(tf.world_tx[stores.transform.denseIndexOf(1)]).toBe(0);
  });

  it("ignores unknown components", () => {
    const world = new World({ initialCapacity: 2 });
    registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 1,
      components: [
        { name: "Unknown", present: [1], fieldOrder: ["value"], columns: [[5]] },
      ],
    };

    expect(() => loadScene(world, scene)).not.toThrow();
    expect(world.entities.size).toBe(1);
  });

  it("remaps link columns and respects NONE values", () => {
    const world = new World({ initialCapacity: 8 });
    const { world: populated } = populateWorld(new World({ initialCapacity: 8 }));
    const scene = saveScene(populated);

    registerAll(world);
    loadScene(world, scene);

    const nodeStore = world.store(TransformNode.meta.name);
    const parentColumn = nodeStore.fields().parent;
    expect(parentColumn[nodeStore.denseIndexOf(0)]).toBe(NONE);
    expect(parentColumn[nodeStore.denseIndexOf(1)]).toBe(0);
  });

  it("grows stores as needed during pre-allocation", () => {
    const world = new World({ initialCapacity: 1 });
    const stores = registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 10,
      components: [
        {
          name: Transform.meta.name,
          present: new Array(10).fill(1),
          fieldOrder: ["world_tx"],
          columns: [Array.from({ length: 10 }, (_, i) => i)],
        },
      ],
    };

    loadScene(world, scene);

    expect(stores.transform.capacity).toBeGreaterThanOrEqual(10);
    const tf = stores.transform.fields();
    for (let i = 0; i < 10; i++) {
      expect(tf.world_tx[stores.transform.denseIndexOf(i)]).toBe(i);
    }
  });

  it("passes legacy root hints to hierarchy rebuilders", () => {
    const world = new World({ initialCapacity: 4 });
    registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 2,
      components: [
        {
          name: TransformNode.meta.name,
          present: [1, 1],
          fieldOrder: ["parent"],
          columns: [[NONE, 0]],
        },
        {
          name: RenderNode.meta.name,
          present: [1, 1],
          fieldOrder: ["parent"],
          columns: [[NONE, NONE]],
        },
      ],
      roots: { transform: [0], render: [1] },
    };

    loadScene(world, scene);

    expect(rebuildCalls).toEqual([
      { name: TransformNode.meta.name, hints: [0] },
      { name: RenderNode.meta.name, hints: [1] },
    ]);
  });

  it("handles map-based root hints", () => {
    const world = new World({ initialCapacity: 4 });
    registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 3,
      components: [
        {
          name: TransformNode.meta.name,
          present: [1, 1, 1],
          fieldOrder: ["parent"],
          columns: [[NONE, 0, 1]],
        },
        {
          name: RenderNode.meta.name,
          present: [1, 0, 1],
          fieldOrder: ["parent"],
          columns: [[NONE, NONE]],
        },
      ],
      roots: {
        [TransformNode.meta.name]: [0, 2],
        [RenderNode.meta.name]: [0],
      },
    };

    loadScene(world, scene);

    expect(rebuildCalls).toEqual([
      { name: TransformNode.meta.name, hints: [0, 2] },
      { name: RenderNode.meta.name, hints: [0] },
    ]);
  });

  it("invokes rebuilders without hints when none are provided", () => {
    const world = new World({ initialCapacity: 2 });
    registerAll(world);
    const scene: RmfwSceneV1 = {
      version: 1,
      project: "rmfw",
      entityCount: 1,
      components: [
        {
          name: TransformNode.meta.name,
          present: [1],
          fieldOrder: ["parent"],
          columns: [[NONE]],
        },
      ],
    };

    loadScene(world, scene);

    expect(rebuildCalls).toEqual([
      { name: TransformNode.meta.name, hints: undefined },
      { name: RenderNode.meta.name, hints: undefined },
    ]);
  });
});

describe("save/load round trip", () => {
  it("round-trips scenes while preserving hierarchy links", () => {
    const { world } = populateWorld(new World({ initialCapacity: 8 }));
    const original = saveScene(world, { includeRoots: true });

    const targetWorld = new World({ initialCapacity: 1 });
    registerAll(targetWorld);
    loadScene(targetWorld, original);
    const reSaved = saveScene(targetWorld, { includeRoots: true });

    expect(reSaved).toEqual(original);
  });
});
