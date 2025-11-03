// src/ecs/tree/rehydraters.ts
import type { World } from "../core/world.js";

/** Rehydrater signature: attach hierarchy to existing stores. */
export type HierarchyRehydrater = (
  world: World,
  dataMeta: Readonly<{ name: string; fields: readonly any[] }> | null,
  nodeMeta: Readonly<{ name: string; fields: readonly any[] }>
) => void;

const REGISTRY = new Map<string, HierarchyRehydrater>();
let DEFAULT_REHYDRATER: HierarchyRehydrater | null = null;

/** Register a rehydrater for a specific node-component name. */
export function registerHierarchyRehydrater(nodeComponentName: string, fn: HierarchyRehydrater): void {
  REGISTRY.set(nodeComponentName, fn);
}

/** Set a default fallback rehydrater (used if no specific handler is registered). */
export function setDefaultHierarchyRehydrater(fn: HierarchyRehydrater): void {
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
