import {
  EntityType,
  type Box,
  type Camera,
  type Entity,
  type GateBox,
  type ReduceUnion,
  type SimpleIntersection,
  type SimpleSubtract,
  type SimpleUnion,
  type Sphere,
  type UnioinWithXform,
} from "./entityDef.js";
import { Vector3 } from "./utils/math.js";

export interface EntityLayout {
  G: {
    H_TYPE: number;
    H_XFORM: number;
    H_MAT: number;
    H_FLAGS: number;
    V0X: number;
    V0Y: number;
    V0Z: number;
    V0W: number;
    V1X: number;
    V1Y: number;
    V1Z: number;
    V1W: number;
  };
  GPU_LANES: number;
}

export interface EntityPackContext {
  layout: EntityLayout;
  i32: Int32Array;
  f32: Float32Array;
  flags: {
    hasGate: number;
  };
}

export interface EntityUnpackContext {
  layout: EntityLayout;
  i32: Int32Array;
  f32: Float32Array;
}

export interface EntityPayloadContext {
  xformID: number;
}

export type EntityFor<T extends EntityType> =
  T extends EntityType.Camera ? Camera :
  T extends EntityType.Sphere ? Sphere :
  T extends EntityType.Box ? Box :
  T extends EntityType.unionWithXform ? UnioinWithXform :
  T extends EntityType.GateBox ? GateBox :
  T extends EntityType.ReduceUnion ? ReduceUnion :
  T extends EntityType.SimpleUnion ? SimpleUnion :
  T extends EntityType.SimpleSubtract ? SimpleSubtract :
  T extends EntityType.SimpleIntersection ? SimpleIntersection :
  never;

export interface EntitySpec<T extends Entity = Entity> {
  type: EntityType;
  staticId: number;
  label: string;
  hasTransform: boolean;
  createDefault(options?: { xformID?: number; overrides?: Partial<T> }): T;
  fromJSON(payload: any, ctx: EntityPayloadContext): T;
  pack(baseIndex: number, entity: T, ctx: EntityPackContext): void;
  unpack(baseIndex: number, ctx: EntityUnpackContext): T;
}

const specTable: Record<number, EntitySpec<any> | undefined> = {};
const specList: EntitySpec[] = [];

function registerSpec<T extends Entity>(spec: EntitySpec<T>): void {
  if (specTable[spec.type]) {
    throw new Error(`EntitySpec for type ${spec.type} already registered`);
  }
  specTable[spec.type] = spec;
  specList.push(spec);
}

function applyOverrides<T>(base: T, overrides?: Partial<T>): T {
  if (overrides) Object.assign(base as object, overrides);
  return base;
}

function coerceNumber(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function coerceInt(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? (n | 0) : fallback;
}

function vector3From(
  value: any,
  fallback: [number, number, number] = [0, 0, 0]
): Vector3 {
  if (value instanceof Vector3) {
    return new Vector3(value.x, value.y, value.z);
  }
  if (Array.isArray(value)) {
    return new Vector3(
      coerceNumber(value[0], fallback[0]),
      coerceNumber(value[1], fallback[1]),
      coerceNumber(value[2], fallback[2])
    );
  }
  if (value && typeof value === "object") {
    return new Vector3(
      coerceNumber(value.x, fallback[0]),
      coerceNumber(value.y, fallback[1]),
      coerceNumber(value.z, fallback[2])
    );
  }
  return new Vector3(fallback[0], fallback[1], fallback[2]);
}

registerSpec<Camera>({
  type: EntityType.Camera,
  staticId: EntityType.Camera,
  label: "Camera",
  hasTransform: true,
  createDefault: ({ xformID = -1, overrides } = {}) =>
    applyOverrides<Camera>(
      {
        type: EntityType.Camera,
        xformID,
      },
      overrides
    ),
  fromJSON: (_payload, ctx) => ({
    type: EntityType.Camera,
    xformID: ctx.xformID,
  }),
  pack: (base, entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.Camera;
    i32[base + G.H_XFORM] = entity.xformID | 0;
    i32[base + G.H_MAT] = -1;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: (base, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    const xformID = i32[base + G.H_XFORM] | 0;
    return { type: EntityType.Camera, xformID };
  },
});

registerSpec<Sphere>({
  type: EntityType.Sphere,
  staticId: EntityType.Sphere,
  label: "Sphere",
  hasTransform: true,
  createDefault: ({ xformID = -1, overrides } = {}) =>
    applyOverrides<Sphere>(
      {
        type: EntityType.Sphere,
        xformID,
        radius: 1,
      },
      overrides
    ),
  fromJSON: (payload, ctx) => {
    const sphere: Sphere = {
      type: EntityType.Sphere,
      xformID: ctx.xformID,
      radius: coerceNumber(payload?.radius, 0),
    };
    if (payload?.material !== undefined) {
      sphere.material = coerceInt(payload.material, 0);
    }
    return sphere;
  },
  pack: (base, entity, ctx) => {
    const { layout, i32, f32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.Sphere;
    i32[base + G.H_XFORM] = entity.xformID | 0;
    i32[base + G.H_MAT] = entity.material ?? -1;
    i32[base + G.H_FLAGS] = 0;
    f32[base + G.V0X] = entity.radius;
  },
  unpack: (base, ctx) => {
    const { layout, i32, f32 } = ctx;
    const G = layout.G;
    const xformID = i32[base + G.H_XFORM] | 0;
    const material = i32[base + G.H_MAT] | 0;
    const radius = f32[base + G.V0X];
    return { type: EntityType.Sphere, xformID, material, radius };
  },
});

registerSpec<Box>({
  type: EntityType.Box,
  staticId: EntityType.Box,
  label: "Box",
  hasTransform: true,
  createDefault: ({ xformID = -1, overrides } = {}) =>
    applyOverrides<Box>(
      {
        type: EntityType.Box,
        xformID,
        bounds: new Vector3(1, 1, 1),
      },
      overrides
    ),
  fromJSON: (payload, ctx) => {
    const box: Box = {
      type: EntityType.Box,
      xformID: ctx.xformID,
      bounds: vector3From(payload?.bounds),
    };
    if (payload?.material !== undefined) {
      box.material = coerceInt(payload.material, 0);
    }
    return box;
  },
  pack: (base, entity, ctx) => {
    const { layout, i32, f32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.Box;
    i32[base + G.H_XFORM] = entity.xformID | 0;
    i32[base + G.H_MAT] = (entity.material ?? 0) | 0;
    i32[base + G.H_FLAGS] = 0;
    f32[base + G.V0X] = entity.bounds.x;
    f32[base + G.V0Y] = entity.bounds.y;
    f32[base + G.V0Z] = entity.bounds.z;
  },
  unpack: (base, ctx) => {
    const { layout, i32, f32 } = ctx;
    const G = layout.G;
    const xformID = i32[base + G.H_XFORM] | 0;
    const material = i32[base + G.H_MAT] | 0;
    const bounds = new Vector3(
      f32[base + G.V0X],
      f32[base + G.V0Y],
      f32[base + G.V0Z]
    );
    return { type: EntityType.Box, xformID, material, bounds };
  },
});

registerSpec<UnioinWithXform>({
  type: EntityType.unionWithXform,
  staticId: EntityType.unionWithXform,
  label: "Union (Xform)",
  hasTransform: true,
  createDefault: ({ xformID = -1, overrides } = {}) =>
    applyOverrides<UnioinWithXform>(
      {
        type: EntityType.unionWithXform,
        xformID,
        children: 0,
      },
      overrides
    ),
  fromJSON: (payload, ctx) => ({
    type: EntityType.unionWithXform,
    xformID: ctx.xformID,
    children: coerceInt(payload?.children, 0),
  }),
  pack: (base, entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.unionWithXform;
    i32[base + G.H_XFORM] = entity.xformID | 0;
    i32[base + G.H_MAT] = entity.children | 0;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: (base, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    const xformID = i32[base + G.H_XFORM] | 0;
    const children = i32[base + G.H_MAT] | 0;
    return { type: EntityType.unionWithXform, xformID, children };
  },
});

registerSpec<GateBox>({
  type: EntityType.GateBox,
  staticId: EntityType.GateBox,
  label: "Gate Box",
  hasTransform: true,
  createDefault: ({ xformID = -1, overrides } = {}) =>
    applyOverrides<GateBox>(
      {
        type: EntityType.GateBox,
        xformID,
        bounds: new Vector3(1, 1, 1),
      },
      overrides
    ),
  fromJSON: (payload, ctx) => ({
    type: EntityType.GateBox,
    xformID: ctx.xformID,
    bounds: vector3From(payload?.bounds),
  }),
  pack: (base, entity, ctx) => {
    const { layout, i32, f32, flags } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.GateBox;
    i32[base + G.H_XFORM] = entity.xformID | 0;
    i32[base + G.H_MAT] = 0;
    i32[base + G.H_FLAGS] = flags.hasGate;
    f32[base + G.V0X] = entity.bounds.x;
    f32[base + G.V0Y] = entity.bounds.y;
    f32[base + G.V0Z] = entity.bounds.z;
  },
  unpack: (base, ctx) => {
    const { layout, i32, f32 } = ctx;
    const G = layout.G;
    const xformID = i32[base + G.H_XFORM] | 0;
    const bounds = new Vector3(
      f32[base + G.V0X],
      f32[base + G.V0Y],
      f32[base + G.V0Z]
    );
    return { type: EntityType.GateBox, xformID, bounds };
  },
});

registerSpec<ReduceUnion>({
  type: EntityType.ReduceUnion,
  staticId: EntityType.ReduceUnion,
  label: "Reduce Union",
  hasTransform: false,
  createDefault: ({ overrides } = {}) =>
    applyOverrides<ReduceUnion>(
      {
        type: EntityType.ReduceUnion,
        children: 0,
      },
      overrides
    ),
  fromJSON: (payload) => ({
    type: EntityType.ReduceUnion,
    children: coerceInt(payload?.children, 0),
  }),
  pack: (base, entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.ReduceUnion;
    i32[base + G.H_XFORM] = -1;
    i32[base + G.H_MAT] = entity.children | 0;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: (base, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    const children = i32[base + G.H_MAT] | 0;
    return { type: EntityType.ReduceUnion, children };
  },
});

registerSpec<SimpleUnion>({
  type: EntityType.SimpleUnion,
  staticId: EntityType.SimpleUnion,
  label: "Union",
  hasTransform: false,
  createDefault: ({ overrides } = {}) =>
    applyOverrides<SimpleUnion>({ type: EntityType.SimpleUnion }, overrides),
  fromJSON: () => ({ type: EntityType.SimpleUnion }),
  pack: (base, _entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.SimpleUnion;
    i32[base + G.H_XFORM] = -1;
    i32[base + G.H_MAT] = 0;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: () => ({ type: EntityType.SimpleUnion }),
});

registerSpec<SimpleSubtract>({
  type: EntityType.SimpleSubtract,
  staticId: EntityType.SimpleSubtract,
  label: "Subtract",
  hasTransform: false,
  createDefault: ({ overrides } = {}) =>
    applyOverrides<SimpleSubtract>({ type: EntityType.SimpleSubtract }, overrides),
  fromJSON: () => ({ type: EntityType.SimpleSubtract }),
  pack: (base, _entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.SimpleSubtract;
    i32[base + G.H_XFORM] = -1;
    i32[base + G.H_MAT] = 0;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: () => ({ type: EntityType.SimpleSubtract }),
});

registerSpec<SimpleIntersection>({
  type: EntityType.SimpleIntersection,
  staticId: EntityType.SimpleIntersection,
  label: "Intersection",
  hasTransform: false,
  createDefault: ({ overrides } = {}) =>
    applyOverrides<SimpleIntersection>({ type: EntityType.SimpleIntersection }, overrides),
  fromJSON: () => ({ type: EntityType.SimpleIntersection }),
  pack: (base, _entity, ctx) => {
    const { layout, i32 } = ctx;
    const G = layout.G;
    i32[base + G.H_TYPE] = EntityType.SimpleIntersection;
    i32[base + G.H_XFORM] = -1;
    i32[base + G.H_MAT] = 0;
    i32[base + G.H_FLAGS] = 0;
  },
  unpack: () => ({ type: EntityType.SimpleIntersection }),
});

export function hasEntitySpec(type: number): type is EntityType {
  return specTable[type] != null;
}

export function getEntitySpec<T extends EntityType>(type: T): EntitySpec<EntityFor<T>> {
  const spec = specTable[type];
  if (!spec) throw new Error(`entity spec: unsupported type ${type}`);
  return spec as EntitySpec<EntityFor<T>>;
}

export function resolveEntityType(payload: any): EntityType {
  const raw = payload?.type;
  const type = typeof raw === "number" ? (raw | 0) : NaN;
  if (!Number.isFinite(type) || !hasEntitySpec(type)) {
    throw new Error(`entity spec: invalid or unsupported payload type ${raw}`);
  }
  return type as EntityType;
}

export function getEntitySpecFromPayload(payload: any): EntitySpec {
  return getEntitySpec(resolveEntityType(payload));
}

export function createEntityFromPayload(payload: any, ctx: EntityPayloadContext): Entity {
  const spec = getEntitySpecFromPayload(payload);
  return spec.fromJSON(payload, ctx);
}

export function entityHasTransform(type: EntityType): boolean {
  return getEntitySpec(type).hasTransform;
}

export function entityHasTransformFromPayload(payload: any): boolean {
  return getEntitySpecFromPayload(payload).hasTransform;
}

export function createDefaultEntity<T extends EntityType>(
  type: T,
  options?: { xformID?: number; overrides?: Partial<EntityFor<T>> }
): EntityFor<T> {
  const spec = getEntitySpec(type);
  return spec.createDefault(options as any);
}

export function listEntitySpecs(): readonly EntitySpec[] {
  return specList;
}

