export type Entity = number;

export type ScalarCtor =
  | Float32ArrayConstructor
  | Int32ArrayConstructor
  | Uint32ArrayConstructor;

export type FieldMeta<K extends string = string> = Readonly<{
  key: K;
  ctor: ScalarCtor;
  default?: number;
  link?: boolean; // true if the field encodes an entity-id/link (e.g. parent)
}>;

export type ComponentMeta<
  Name extends string = string,
  K extends string = string
> = Readonly<{
  name: Name;
  fields: ReadonlyArray<FieldMeta<K>>;
}>;

export interface QueryView {
  driver: string;
  count: number;
  entities: Int32Array; // [count]
  rows: Record<string, Int32Array>; // rows[name][i] = dense row index in that store
}

/** Union of field keys for a given meta. */
export type KeysOf<M extends ComponentMeta> = M["fields"][number]["key"];

/** Readonly column map for a given meta. */
export type ColumnsOf<M extends ComponentMeta> = Readonly<{
  [K in KeysOf<M>]: Float32Array | Int32Array | Uint32Array;
}>;

/** Mutable column map (internal use). */
export type MutableColumnsOf<M extends ComponentMeta> = {
  [K in KeysOf<M>]: Float32Array | Int32Array | Uint32Array;
};

/** A Component definition: just the meta. */
export type Def<M extends ComponentMeta = ComponentMeta> = Readonly<{
  meta: M;
}>;

/** Extract the meta from a Def. */
export type MetaOf<D extends Def> = D["meta"];

export type HierarchyLike = {
  /** Detach subtree root 'entity' (becomes root); no-ops if entity isn't present. */
  remove(entity: number): void;
  /** Name for debugging (e.g., "TransformNode", "RenderNode") */
  componentName?: string;
};