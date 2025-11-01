#!/usr/bin/env node
// scripts/sceneBuilder.ts
//
// Skeleton scene builder for experimenting with the rmfw ECS.
// Run with: `node --loader ts-node/esm scripts/sceneBuilder.ts`
// (or your preferred TypeScript runner). Adjust entity/component setup below
// to craft different scenes, then re-run to generate a fresh JSON save.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  initWorld,
  TransformMeta,
  TransformNodeMeta,
  RenderNodeMeta,
  ShapeLeafMeta,
  OperationMeta,
} from "../src/ecs/core/registry.js";
import { buildAllHierarchyTrees } from "../src/ecs/trees.js";
import { saveScene } from "../src/ecs/save.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const OUTPUT_PATH = resolve(__dirname, "../scenes/sample-scene.json");

function ensureDirectoryFor(filePath: string) {
  mkdirSync(dirname(filePath), { recursive: true });
}

function ensureTransform(world: ReturnType<typeof initWorld>, entity: number) {
  const transformStore = world.storeOf(TransformMeta);
  let row = transformStore.denseIndexOf(entity);
  if (row < 0) {
    row = transformStore.add(entity);
  }
  const tf = transformStore.fields();
  return { row, tf };
}

function setTranslation(world: ReturnType<typeof initWorld>, entity: number, xyz: [number, number, number]) {
  const { row, tf } = ensureTransform(world, entity);
  const [x, y, z] = xyz;
  tf.local_tx[row] = x;
  tf.local_ty[row] = y;
  tf.local_tz[row] = z;
  tf.world_tx[row] = x;
  tf.world_ty[row] = y;
  tf.world_tz[row] = z;
  tf.inv_tx[row] = -x;
  tf.inv_ty[row] = -y;
  tf.inv_tz[row] = -z;
}

async function main() {
  const world = initWorld({ initialCapacity: 64 });
  const trees = buildAllHierarchyTrees(world);
  const transformTree = trees.get(TransformNodeMeta.name)!;
  const renderTree = trees.get(RenderNodeMeta.name)!;

  // --- Entity layout -------------------------------------------------------
  const root = world.createEntity();
  const sphere = world.createEntity();
  const subtractNode = world.createEntity();
  const box = world.createEntity();

  // Hook entities into the transform/render trees. addChild will auto-add
  // the TransformNode / RenderNode components with neutral defaults.
  transformTree.addChild(root, sphere);
  transformTree.addChild(root, subtractNode);
  transformTree.addChild(subtractNode, box);

  renderTree.addChild(root, sphere);
  renderTree.addChild(root, subtractNode);
  renderTree.addChild(subtractNode, box);

  // Optional: position entities by editing transform translations.
  setTranslation(world, root, [0, 0, 0]);
  setTranslation(world, sphere, [0, 0, 0]);
  setTranslation(world, subtractNode, [0, 0, 0]);
  setTranslation(world, box, [0.5, 0, 0]);

  // --- Shape / operation payload ------------------------------------------
  const shapeStore = world.storeOf(ShapeLeafMeta);
  shapeStore.add(sphere, {
    shapeType: 1, // customize per renderer (e.g. 1 = sphere)
    p0: 0.75,     // radius or renderer-defined param slot
    p1: 0,
    p2: 0,
    p3: 0,
    p4: 0,
    p5: 0,
  });

  const ops = world.storeOf(OperationMeta);
  ops.add(root, { opType: 0 });       // e.g. 0 = union / min
  ops.add(subtractNode, { opType: 1 }); // e.g. 1 = subtract / max(-a, b)

  shapeStore.add(box, {
    shapeType: 2, // customize per renderer (e.g. 2 = rounded box)
    p0: 0.6,
    p1: 0.25,
    p2: 0.25,
    p3: 0,
    p4: 0,
    p5: 0,
  });

  // Trigger a deterministic DFS order for both hierarchies (optional if no
  // mutations after addChild, but safe to call before saving).
  transformTree.rebuildOrder();
  renderTree.rebuildOrder();

  const scene = saveScene(world, {
    dropDefaultColumns: true,
    includeRoots: true,
  });

  ensureDirectoryFor(OUTPUT_PATH);
  writeFileSync(OUTPUT_PATH, JSON.stringify(scene, null, 2));

  console.log(`Scene saved to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error("Scene build failed:", err);
  process.exitCode = 1;
});
