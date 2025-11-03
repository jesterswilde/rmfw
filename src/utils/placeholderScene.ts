import type { World } from "../ecs/core/index.js";
import { ShapeMeta, TransformMeta } from "../ecs/registry";
import { Shape } from "../interfaces.js";

export const makePlaceholderScene = (world: World)=>{
    const entity = world.createEntity();
    const xformStore = world.storeOf(TransformMeta);
    const shapeStore = world.storeOf(ShapeMeta);
    xformStore.add(entity)
    shapeStore.add(entity, {shapeType: Shape.Sphere, p2: 1})
}