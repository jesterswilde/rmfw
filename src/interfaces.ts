export enum RenderKind {
    None = 0,
    Shape = 1,
    Op = 2
}

//OP and Shape will never overlap as wgsl reads them both as 'kind'
export enum Shape {
    Sphere = 0,
    Box = 1
}
export enum Op {
    ReduceUnion = 100,
    Union = 101,
    Subtract = 102,
    Intersect = 103,
    BoxGate = 200,    
    Camera = 300
}