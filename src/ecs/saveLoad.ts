// src/ecs/saveLoad.ts
import type { Def, ComponentMeta } from "./interfaces.js";
import { World } from "./core/index.js";

/**
 * JSON snapshot shape produced by saveWorld / consumed by loadWorld.
 * Mirrors World.export() + a list of tree component names present at save time.
 */
export type WorldSnapshot = Readonly<{
  allocator: {
    _dense: number[];
    _sparse: number[];
    _free: number[];
    _next: number;
    entityEpoch: number[];
  };
  components: {
    [name: string]: {
      name: string;
      size: number;
      capacity: number;
      storeEpoch: number;
      entityToDense: number[];
      denseToEntity: number[];
      rowVersion: number[];
      fields: { [key: string]: number[] };
    };
  };
  protectedIds: number[];
  /** Names of node components that participate in trees (e.g., "TransformNode") */
  trees: string[];
}>;

/** Options for saveWorld (default densify = true) */
export type SaveOptions = Readonly<{
  densify?: boolean;
}>;

/** Rehydrator is called once per tree name after the world has been imported. */
export type TreeRehydrator = (world: World) => void;

/** Map from tree component name -> rehydrator function. */
export type TreeRehydrators = Readonly<Record<string, TreeRehydrator>>;

/**
 * Build a pure-JSON snapshot of the world.
 * By default densifies ids (old->new ascending) before serializing.
 * Includes a list of tree component names discovered via registered hierarchies.
 */
export function saveWorld(world: World, opts: SaveOptions = {}): WorldSnapshot {
  const densify = opts.densify ?? true;

  // 1) Collect tree component names from registered trees
  const treeNames: string[] = [];
  world.forEachTree((name, h) => {
    // Prefer explicit componentName if provided by the tree, else registry key
    const compName = h.componentName || name;
    if (!treeNames.includes(compName)) treeNames.push(compName);
  });

  // 2) Use World's export (already handles densify + link remapping)
  const core = world.export({ densify });

  // 3) Return composite snapshot with trees list
  const snapshot: WorldSnapshot = {
    allocator: core.allocator,
    components: core.components,
    protectedIds: core.protectedIds,
    trees: treeNames,
  };
  return snapshot;
}

/**
 * Save to a JSON string (convenience wrapper).
 */
export function saveWorldToJSON(world: World, opts: SaveOptions = {}): string {
  const snap = saveWorld(world, opts);
  return JSON.stringify(snap);
}

/**
 * Load a snapshot (object or JSON string) into an existing world.
 * Requires that all component metas are already registered in `world`.
 * After store rehydration, tree rehydrators (if provided) will be called
 * for each tree name present in the snapshot.
 */
export function loadWorld(
  world: World,
  snapshotOrJSON: WorldSnapshot | string,
  rehydrators: TreeRehydrators = {}
): void {
  const snapshot: WorldSnapshot =
    typeof snapshotOrJSON === "string"
      ? (JSON.parse(snapshotOrJSON) as WorldSnapshot)
      : snapshotOrJSON;

  // 1) Core import (allocator + stores + protected set)
  world.import({
    allocator: snapshot.allocator,
    components: snapshot.components,
    protectedIds: snapshot.protectedIds,
  });

  // 2) Reattach trees (optional; best-effort per provided rehydrators)
  for (const treeName of snapshot.trees) {
    const fn = rehydrators[treeName];
    if (typeof fn === "function") {
      fn(world);
    }
    // If not provided, it's a no-op; caller can rehydrate later.
  }
}

/**
 * Load from JSON string (convenience wrapper).
 */
export function loadWorldFromJSON(
  world: World,
  json: string,
  rehydrators: TreeRehydrators = {}
): void {
  loadWorld(world, json, rehydrators);
}
