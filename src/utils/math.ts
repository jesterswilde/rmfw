export class Vector3 { 
    x: number;
    y: number;
    z: number;

    constructor(x: number, y: number, z: number) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    add(other: Vector3): Vector3 {
        return new Vector3(this.x + other.x, this.y + other.y, this.z + other.z);
    }

    subtract(other: Vector3): Vector3 {
        return new Vector3(this.x - other.x, this.y - other.y, this.z - other.z);
    }
    multiply(scalar: number): Vector3 {
        return new Vector3(this.x * scalar, this.y * scalar, this.z * scalar);
    }
    length(): number {
        return Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z);
    }
    normalize(): Vector3 {
        return this.multiply(1 / this.length());
    }
}

export interface EulerZYX {
  yawZ: number;
  pitchY: number;
  rollX: number;
  units?: "rad" | "deg";
}

export const deg2rad = (d: number) => (d * Math.PI) / 180;
export const rad2deg = (r: number) => (r * 180) / Math.PI;
