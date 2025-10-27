import type { EulerZYX, Vector3 } from "./utils/math.js"

export enum EntityType { 
    Camera = 0,
    Sphere =  1,
    Box = 2,

    ReduceUnion = 20,
    SimpleUnion = 21,
    SimpleSubtract = 22,
    SimpleIntersection = 23,

    GateBox = 40
}
export interface Transform{
    position: Vector3
    rotation: EulerZYX
}
export interface ShapeBase{
    material?: number
    xformID: number
}
export interface Box extends ShapeBase { 
    type: EntityType.Box,
    bounds: Vector3
}
export interface Sphere extends ShapeBase {
    type: EntityType.Sphere,
    radius: number
}
export interface Camera { 
    type: EntityType.Camera
    xformID: number
}
export interface ReduceUnion {
    type: EntityType.ReduceUnion,
    children: number
}
export interface SimpleUnion {
    type: EntityType.SimpleUnion,
}
export interface SimpleSubtract {
    type: EntityType.SimpleSubtract,
}
export interface SimpleIntersection {
    type: EntityType.SimpleIntersection,
}
export interface GateBox{
    type: EntityType.GateBox,
    xformID: number
    bounds: Vector3
}

export type Entity = Camera
    | Sphere 
    | Box 
    | ReduceUnion 
    | SimpleUnion
    | SimpleIntersection 
    | SimpleSubtract
    | GateBox