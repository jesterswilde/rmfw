import { Vector3 } from "./utils/math.js";
import { Mat4 } from "./utils/matrix4x4.js";

let yaw = 0;
let pitch = 0;
let lookSensitivity = 5;
let moveSpeed = 5;
const PITCH_LIMIT = Math.PI / 2 - 1e-3;
export const camera: Mat4 = Mat4.fromTranslation(new Vector3(0,0,-2));

export const moveCam = (move: Vector3, deltaTime: number)=>{
    if(move.x !== 0 || move.y !== 0 || move.z !== 0){
      var newDir = camera.transformDirection(move)
      camera.addTranslation(newDir.multiply(deltaTime * moveSpeed));
    }
}
export const rotateCam = (mouse: Vector3)=>{
    if (mouse.x !== 0 || mouse.y !== 0) {
      yaw   += mouse.x * lookSensitivity;  // left/right → world yaw
      pitch += mouse.y * lookSensitivity;  // up/down    → local pitch

      if (pitch >  PITCH_LIMIT) 
        pitch =  PITCH_LIMIT;
      if (pitch < -PITCH_LIMIT)
        pitch = -PITCH_LIMIT;

      const { position } = camera.toTRS("rad");

      const R = Mat4.identity()
        .rotateWorldAxis(new Vector3(0,1,0), yaw)
        .rotateAxisAngle(new Vector3(1,0,0), pitch);

      R.setTranslation(position);
      camera.m.set(R.m); 
    }
}