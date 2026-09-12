import * as THREE from "three";

/**
 * Turning CS2 view angles into three.js rotations.
 *
 * Two conventions bite here:
 *  - Source measures yaw counter-clockwise from +X, and positive *pitch looks
 *    down*, the opposite of a three.js rotation about X.
 *  - `cs2ToThree` maps (x, y, z) -> (x, z, -y), so the yaw plane is three's XZ.
 *
 * Everything we aim (the camera, and player rigs whose guns point down local
 * -Z) faces -Z, so one rotation serves both.
 */

/** Where the player is looking, as a unit vector in three.js space. */
export function cs2Forward(pitchDeg: number, yawDeg: number): THREE.Vector3 {
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const yaw = THREE.MathUtils.degToRad(yawDeg);
  // Source AngleVectors: positive pitch drives forward.z negative (downward).
  const cp = Math.cos(pitch);
  const x = cp * Math.cos(yaw);
  const y = cp * Math.sin(yaw);
  const z = -Math.sin(pitch);
  // cs2ToThree
  return new THREE.Vector3(x, z, -y);
}

/** Euler angles (YXZ) that aim a -Z facing object along the player's view. */
export function cs2ViewEuler(pitchDeg: number, yawDeg: number): THREE.Euler {
  return new THREE.Euler(
    -THREE.MathUtils.degToRad(pitchDeg),
    THREE.MathUtils.degToRad(yawDeg) - Math.PI / 2,
    0,
    "YXZ",
  );
}

/** Yaw-only rotation, for standing bodies that should not tilt with the aim. */
export function cs2BodyEuler(yawDeg: number): THREE.Euler {
  return new THREE.Euler(0, THREE.MathUtils.degToRad(yawDeg) - Math.PI / 2, 0, "YXZ");
}
