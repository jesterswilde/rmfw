// src/ecs/tree/rehydraters.ts
import type { World } from "../core/world.js";

/** Rehydrater signature: attach tree to existing stores. */
export type TreeRehydrater = (
  world: World,
  dataMeta: Readonly<{ name: string; fields: readonly any[] }> | null,
  nodeMeta: Readonly<{ name: string; fields: readonly any[] }>
) => void;

const REGISTRY = new Map<string, TreeRehydrater>();
let DEFAULT_REHYDRATER: TreeRehydrater | null = null;

/** Register a rehydrater for a specific node-component name. */
export function registerTreeRehydrater(nodeComponentName: string, fn: TreeRehydrater): void {
  REGISTRY.set(nodeComponentName, fn);
}

/** Set a default fallback rehydrater (used if no specific handler is registered). */
export function setDefaultTreeRehydrater(fn: TreeRehydrater): void {
  DEFAULT_REHYDRATER = fn;
}

/** Invoke a rehydrater for a node-component (or the default one if none is registered). */
export function rehydrateByNodeName(
  world: World,
  dataMeta: Readonly<{ name: string; fields: readonly any[] }> | null,
  nodeMeta: Readonly<{ name: string; fields: readonly any[] }>
): void {
  const fn = REGISTRY.get(nodeMeta.name) ?? DEFAULT_REHYDRATER;
  if (!fn) throw new Error(`No rehydrater registered for '${nodeMeta.name}' and no default set`);
  fn(world, dataMeta, nodeMeta);
}
