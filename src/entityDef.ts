import type { EulerZYX, Vector3 } from "./utils/math.js"

export enum ShapeType { 
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
    type: ShapeType.Box,
    bounds: Vector3
}
export interface Sphere extends ShapeBase {
    type: ShapeType.Sphere,
    radius: number
}
export interface Camera { 
    type: ShapeType.Camera
    xformID: number
}
export interface ReduceUnion {
    type: ShapeType.ReduceUnion,
    children: number
}
export interface SimpleUnion {
    type: ShapeType.SimpleUnion,
}
export interface SimpleSubtract {
    type: ShapeType.SimpleSubtract,
}
export interface SimpleIntersection {
    type: ShapeType.SimpleIntersection,
}
export interface GateBox{
    type: ShapeType.GateBox,
    xformID: number
    bounds: Vector3
}

export type Shapes = Camera
    | Sphere 
    | Box 
    | ReduceUnion 
    | SimpleUnion
    | SimpleIntersection 
    | SimpleSubtract
    | GateBox