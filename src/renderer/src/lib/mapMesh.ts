import * as THREE from "three";

/** How the loaded map mesh lined up with the clip's pose bounds. */
export type MapFit = "aligned" | "rotated" | "mismatch";

const FLAT_COLOR = 0x9aa3ad;

/**
 * Collision hulls ship with tool textures. Replace every material with one flat
 * surface so the geometry reads as blocky brushwork rather than checkerboards.
 */
export function flattenMaterials(root: THREE.Object3D) {
  const flat = new THREE.MeshStandardMaterial({
    color: FLAT_COLOR,
    roughness: 0.95,
    metalness: 0.0,
    flatShading: true,
    side: THREE.DoubleSide,
  });
  root.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const previous = mesh.material;
    const list = Array.isArray(previous) ? previous : [previous];
    for (const item of list) item?.dispose?.();
    mesh.material = flat;
    // A collision hull is millions of vertices. flatShading derives normals in the
    // fragment shader and nothing samples a texture, so these attributes are pure
    // GPU memory cost.
    mesh.geometry?.deleteAttribute("normal");
    mesh.geometry?.deleteAttribute("uv");
    mesh.geometry?.deleteAttribute("tangent");
  });
  return flat;
}

/**
 * Pose bounds (CS2 units, Z-up) expressed in three.js space, matching
 * `cs2ToThree`: (x, y, z) -> (x, z, -y).
 */
export function poseBoundsToThree(bounds: {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}) {
  return new THREE.Box3(
    new THREE.Vector3(bounds.minX, bounds.minZ, -bounds.maxY),
    new THREE.Vector3(bounds.maxX, bounds.maxZ, -bounds.minY),
  );
}

/** Lowest share of the pose box that must sit inside the map for a fit to count. */
const FIT_THRESHOLD = 0.75;

/**
 * Fraction of `inner`'s volume that lies inside `outer`.
 *
 * Plain box intersection is far too weak here: a map's bounds are thousands of
 * units across on every axis, so a sideways map still clips a corner of the
 * clip's poses and looks like a match. Players must be *enclosed* by the map.
 */
export function containmentRatio(outer: THREE.Box3, inner: THREE.Box3): number {
  // Give a flat pose box thickness so its volume is never zero.
  const padded = inner.clone().expandByScalar(32);
  const overlap = padded.clone().intersect(outer);
  if (overlap.isEmpty()) return 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  overlap.getSize(a);
  padded.getSize(b);
  const whole = b.x * b.y * b.z;
  return whole > 0 ? (a.x * a.y * a.z) / whole : 0;
}

/** Same mapping as `cs2ToThree`: CS2 is Z-up in inches, three.js is Y-up. */
const CS2_TO_THREE = new THREE.Matrix4().makeRotationX(-Math.PI / 2);

function sameMatrix(a: THREE.Matrix4, b: THREE.Matrix4) {
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a.elements[i] - b.elements[i]) > 1e-6) return false;
  }
  return true;
}

/**
 * Replace the exporter's transform with ours.
 *
 * Source2Viewer bakes its own convention into every node — for CS2 physics
 * exports that is a 0.0254 inch-to-metre scale plus an axis permutation, which
 * leaves the map ~40x too small and turned the wrong way. The vertex data
 * underneath is plain CS2 inches, so undoing that node transform and applying
 * `cs2ToThree` lands the map exactly where the poses already live.
 *
 * Returns false when nodes disagree, since one shared inverse cannot then be
 * correct and the caller should fall back to searching orientations.
 */
export function normalizeSourceMesh(root: THREE.Object3D): boolean {
  root.updateMatrixWorld(true);
  const meshes: THREE.Mesh[] = [];
  root.traverse((child: THREE.Object3D) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh);
  });
  if (meshes.length === 0) return false;

  const exporter = meshes[0].matrixWorld.clone();
  if (!meshes.every((mesh) => sameMatrix(mesh.matrixWorld, exporter))) return false;
  if (Math.abs(exporter.determinant()) < 1e-12) return false;

  // world = (CS2_TO_THREE * exporter^-1) * exporter = CS2_TO_THREE
  root.applyMatrix4(CS2_TO_THREE.clone().multiply(exporter.invert()));
  root.updateMatrixWorld(true);
  return true;
}

/**
 * Place the mesh in pose space, then confirm the players are actually enclosed
 * by it. Normalising is the expected path; the rotation search only covers
 * exports that do not share a single node transform.
 */
export function fitMapMesh(mesh: THREE.Object3D, poseBox: THREE.Box3): MapFit {
  const score = () => containmentRatio(new THREE.Box3().setFromObject(mesh), poseBox);

  if (normalizeSourceMesh(mesh) && score() >= FIT_THRESHOLD) return "aligned";

  const tryRotation = (rotX: number) => {
    mesh.rotation.set(rotX, 0, 0);
    mesh.updateMatrixWorld(true);
    return score();
  };
  const upright = tryRotation(0);
  const rotated = tryRotation(-Math.PI / 2);
  if (Math.max(upright, rotated) < FIT_THRESHOLD) {
    tryRotation(0);
    return "mismatch";
  }
  if (upright >= rotated) {
    tryRotation(0);
    return "aligned";
  }
  return "rotated";
}

export function describeBox(box: THREE.Box3) {
  const f = (n: number) => Math.round(n);
  return `[${f(box.min.x)},${f(box.min.y)},${f(box.min.z)}] .. [${f(box.max.x)},${f(box.max.y)},${f(box.max.z)}]`;
}
