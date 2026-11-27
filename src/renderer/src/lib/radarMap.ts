import * as THREE from "three";
import { crunchTexture, previewLambert } from "./assetMaterials";

export type RadarOverview = {
  image: string;
  lower?: string | null;
  posX: number;
  posY: number;
  scale: number;
  altitudeSplit?: number | null;
};

type Raster = { data: Uint8ClampedArray; width: number; height: number };

function reelUrl(filePath: string) {
  return `reelmap://asset/?path=${encodeURIComponent(filePath.replace(/\\/g, "/"))}`;
}

function loadImage(path: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = reelUrl(path);
  });
}

function rasterFromImage(image: HTMLImageElement): Raster | null {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
  return { data, width, height };
}

export async function loadRadarRaster(path: string | null | undefined): Promise<Raster | null> {
  if (!path) return null;
  const image = await loadImage(path);
  return image ? rasterFromImage(image) : null;
}

function sampleRaster(raster: Raster, px: number, py: number): [number, number, number] | null {
  const x = Math.floor(px);
  const y = Math.floor(py);
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return null;
  const o = (y * raster.width + x) * 4;
  return [raster.data[o] / 255, raster.data[o + 1] / 255, raster.data[o + 2] / 255];
}

/** World XY → radar pixel. CS overview: NW corner is (posX, posY), Y down the image. */
export function worldToRadarPixel(cs2x: number, cs2y: number, radar: RadarOverview) {
  return {
    px: (cs2x - radar.posX) / radar.scale,
    py: (radar.posY - cs2y) / radar.scale,
  };
}

function worldXyFromThree(point: THREE.Vector3) {
  return { x: point.x, y: -point.z };
}

export function cloneDetachedMap(mesh: THREE.Object3D): THREE.Group {
  const clone = mesh.clone(true);
  clone.traverse((child) => {
    const m = child as THREE.Mesh;
    if (m.isMesh && m.geometry) m.geometry = m.geometry.clone();
    if (m.isMesh && m.material) {
      const list = Array.isArray(m.material) ? m.material : [m.material];
      const copied = list.map((mat) => mat.clone());
      m.material = Array.isArray(m.material) ? copied : copied[0];
    }
    if (child.userData) delete child.userData.cached;
  });
  clone.userData.cached = false;
  return clone as THREE.Group;
}

export function applyRadarTintShader(root: THREE.Object3D, radar: RadarOverview, texture: THREE.Texture) {
  crunchTexture(texture);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  const image = texture.image as { width?: number; height?: number } | undefined;
  const size = new THREE.Vector2(image?.width || 1024, image?.height || 1024);
  const origin = new THREE.Vector2(radar.posX, radar.posY);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const mat = new THREE.MeshLambertMaterial({
      color: 0xb0b6bc,
      flatShading: true,
      side: THREE.DoubleSide,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRadar = { value: texture };
      shader.uniforms.uRadarOrigin = { value: origin };
      shader.uniforms.uRadarScale = { value: radar.scale };
      shader.uniforms.uRadarSize = { value: size };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWp;")
        .replace("#include <project_vertex>", "#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vWp;
uniform sampler2D uRadar;
uniform vec2 uRadarOrigin;
uniform float uRadarScale;
uniform vec2 uRadarSize;`,
        )
        .replace(
          "#include <color_fragment>",
          `#include <color_fragment>
vec2 ru = vec2(
  (vWp.x - uRadarOrigin.x) / (uRadarScale * uRadarSize.x),
  (uRadarOrigin.y + vWp.z) / (uRadarScale * uRadarSize.y)
);
if (ru.x >= 0.0 && ru.x <= 1.0 && ru.y >= 0.0 && ru.y <= 1.0) {
  vec3 radarColor = texture2D(uRadar, ru).rgb;
  diffuseColor.rgb = mix(diffuseColor.rgb, radarColor, 0.82);
}`,
        );
    };
    mesh.material = mat;
  });
}

export async function loadRadarTexture(path: string): Promise<THREE.Texture | null> {
  const loader = new THREE.TextureLoader();
  return new Promise((resolve) => {
    loader.load(reelUrl(path), resolve, undefined, () => resolve(null));
  });
}

export async function makeRadarPlane(
  radar: RadarOverview,
  raster: Raster,
  groundY: number,
): Promise<THREE.Mesh | null> {
  const image = await loadImage(radar.image);
  if (!image) return null;
  const loader = new THREE.TextureLoader();
  const texture = await new Promise<THREE.Texture | null>((resolve) => {
    loader.load(reelUrl(radar.image), resolve, undefined, () => resolve(null));
  });
  if (!texture) return null;
  crunchTexture(texture);
  texture.colorSpace = THREE.SRGBColorSpace;
  const worldW = raster.width * radar.scale;
  const worldH = raster.height * radar.scale;
  const geo = new THREE.PlaneGeometry(worldW, worldH);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshLambertMaterial({
      map: texture,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
    }),
  );
  mesh.name = "radarPlane";
  // Plane centre: NW + half extent. Three.js: (cs2x, z, -cs2y).
  const cx = radar.posX + worldW / 2;
  const cy = radar.posY - worldH / 2;
  mesh.position.set(cx, groundY, -cy);
  mesh.renderOrder = -1;
  return mesh;
}

export function stylizeWorld64(root: THREE.Object3D) {
  if (root.userData.world64Styled) return;
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    const previous = mesh.material;
    const list = Array.isArray(previous) ? previous : [previous];
    const next = list.map((mat) => {
      const std = mat as THREE.MeshStandardMaterial;
      const map = std?.map ?? null;
      if (map) crunchTexture(map);
      const color = map ? 0xffffff : (std?.color?.getHex?.() ?? 0x9aa3ad);
      const lambert = previewLambert(color);
      lambert.map = map;
      lambert.side = THREE.DoubleSide;
      lambert.needsUpdate = true;
      return lambert;
    });
    mesh.material = next.length === 1 ? next[0] : next;
  });
  root.userData.world64Styled = true;
}
