import { memo, useEffect, useImperativeHandle, useRef, useState, Component, type ErrorInfo, type ReactNode, type Ref } from "react";
import * as THREE from "three";
import type { Kill } from "../lib/types";
import { Crosshair } from "./Crosshair";
import { PovHud } from "./PovHud";
import { ScopeOverlay } from "./ScopeOverlay";
import {
  cs2ToThree,
  deathAgeIndexed,
  flashAtIndexed,
  indexDump,
  lastEquipIndexed,
  narrowShotWindow,
  poseAtIndexed,
  punchAt,
  reloadProgressIndexed,
  shotsInWindowIndexed,
  throwAgeFromGrenades,
  throwAgeIndexed,
  velocityAtIndexed,
  zoomAgeIndexed,
  type PlaybackIndex,
  type PreviewDump,
  type PreviewPose,
} from "../lib/clipPlayback";
import { isCachedMapMesh, loadMapGltf } from "../lib/loadMapGltf";
import { releaseGltf, retainGltf } from "../lib/loadGltf";
import {
  describeBox,
  fitMapMesh,
  flattenMaterials,
  poseBoundsToThree,
} from "../lib/mapMesh";
import {
  aimRig,
  animateRig,
  makePlayerRig,
  setRigDead,
  setRigDucking,
  setRigWeapon,
  weaponKind,
} from "../lib/playerRig";
import { cs2BodyEuler, cs2ViewEuler } from "../lib/viewAngles";
import {
  animateViewmodel,
  makeViewmodelMotion,
  makeViewmodelRig,
  placeViewmodel,
  seatViewmodel,
  type ViewmodelMotion,
} from "../lib/viewmodel";
import { DEFAULT_VIEWMODEL, type ViewmodelPrefs } from "../lib/previewPrefs";
import {
  applyRadarTintShader,
  loadRadarRaster,
  loadRadarTexture,
  makeRadarPlane,
} from "../lib/radarMap";
import { disposeTracerPool, makeGlowTexture, makeTracerPool, updateTracers, TRACER_WINDOW_SECONDS, type TracerPool } from "../lib/tracers";
import { disposeNadeFx, makeNadeFx, updateNadeFx, bindNadeModels, type NadeFx } from "../lib/nadeFx";
import { disposeDamageFx, makeDamageFx, updateDamageFx, damagePopsForDump, type DamageFx, type DamagePop } from "../lib/damageFx";
import { CASING_WINDOW_SECONDS, disposeCasingPool, makeCasingPool, updateCasings, type CasingPool } from "../lib/casings";
import { bindWorldC4Model, disposeWorldC4, makeWorldC4, updateWorldC4, type WorldC4 } from "../lib/worldC4";
import {
  AGENT_BY_TEAM,
  FALLBACK_AGENT,
  skinKey,
} from "../lib/assetSpec";
import { bundleWeaponPath, type AssetBundle } from "../lib/gameAssets";
import {
  disposeArmsViewmodel,
  makeArmsViewmodel,
  placeArmsViewmodel,
  updateArmsViewmodel,
  type ArmsViewmodel,
} from "../lib/armsViewmodel";
import {
  disposePlayerModel,
  makePlayerModel,
  setPlayerWeapon,
  updatePlayerModel,
  type PlayerModel,
} from "../lib/playerModels";
import { resolveWeapon, weaponCanScope } from "../lib/weaponTable";

const EYE = 64;
const DUCK_EYE = 46;
/** Clip-seconds for the viewmodel kick and its muzzle flash to decay. */
const RECOIL_SECONDS = 0.16;
const MUZZLE_SECONDS = 0.05;
/**
 * Field of view while scoped. The demo only records a scoped boolean, not the
 * zoom level, so this is the first zoom level for every scoped weapon.
 */
const SCOPE_FOV = 40;
const BASE_FOV = 75;
/** Seconds to ease between hip and scoped FOV after a weapon_zoom event. */
const SCOPE_EASE = 0.12;
const WORLD_SCALE = new THREE.Vector3();
const KILL_LINES = 8;

export type ArmsStatus = "real" | "procedural" | "failed";

/** What the viewport is actually drawing for the map, as opposed to what was exported. */
export type MapStatus = "loading" | "ready" | "failed" | "mismatch";

export type ClipStageHandle = { seek: (tick: number) => void };

type StageHud = {
  alive: boolean;
  scoped: boolean;
  weapon: string;
  health: number;
  armor: number;
  place: string;
  team: string;
  pose?: PreviewPose;
};

function hudKey(hud: StageHud) {
  return `${hud.alive}|${hud.scoped}|${hud.weapon}|${hud.health}|${hud.armor}|${hud.place}|${hud.team}`;
}

function makeKillLine() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xf07178, transparent: true, opacity: 0.85 }),
  );
  line.visible = false;
  line.frustumCulled = false;
  return line;
}

type Props = {
  dump: PreviewDump | null;
  clipId?: string | null;
  kills: Kill[];
  assets?: AssetBundle | null;
  /** False during the first asset wave so third-person models wait for locomotion. */
  assetsReady?: boolean;
  vmPrefs?: ViewmodelPrefs;
  mapRev?: number;
  onMapStatus?: (status: MapStatus) => void;
  onArmsStatus?: (status: ArmsStatus) => void;
  ref?: Ref<ClipStageHandle>;
};

function attachMuzzleFlash(host: THREE.Object3D) {
  let flash = host.getObjectByName("muzzleFlash") as THREE.Sprite | undefined;
  if (!flash && host.parent) {
    flash = host.parent.getObjectByName("muzzleFlash") as THREE.Sprite | undefined;
  }
  if (!flash) {
    flash = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flash.name = "muzzleFlash";
    flash.visible = false;
  }
  if (flash.parent !== host) host.add(flash);
  flash.position.set(0, 0, 0);
}

function pulseMuzzleFlash(host: THREE.Object3D, amount: number, silenced: boolean) {
  attachMuzzleFlash(host);
  const flash = host.getObjectByName("muzzleFlash") as THREE.Sprite | undefined;
  if (!flash) return;
  const strength = silenced ? amount * 0.22 : amount;
  flash.visible = strength > 0.02;
  (flash.material as THREE.SpriteMaterial).opacity = strength * 0.9;
  // Attached guns live in metres under an inches-scaled skeleton. A raw
  // scale of 3 would be ~10 ft across and wash the whole lens.
  host.updateMatrixWorld(true);
  const worldScale = Math.max(1e-4, host.getWorldScale(WORLD_SCALE).x);
  const inches = (silenced ? 1.6 : 3.4) * (0.8 + 0.35 * (1 - strength));
  const size = inches / worldScale;
  flash.scale.set(size, size, 1);
}

function scopedFov(scoped: boolean, age: number | null) {
  const to = scoped ? SCOPE_FOV : BASE_FOV;
  if (age === null || age >= SCOPE_EASE) return to;
  const from = scoped ? BASE_FOV : SCOPE_FOV;
  const t = Math.min(1, Math.max(0, age / SCOPE_EASE));
  return from + (to - from) * t;
}

/** Eases with the crouch instead of popping between two heights. */
function eyeHeight(pose: PreviewPose) {
  const duck = pose.duck ?? (pose.ducking ? 1 : 0);
  return EYE + (DUCK_EYE - EYE) * Math.min(1, Math.max(0, duck));
}

type ClipActors = {
  players: Map<string, THREE.Group>;
  realPlayers: Map<string, PlayerModel>;
  playerLoading: Set<string>;
  arms: ArmsViewmodel | null;
  armsId: string;
  armsLoading: string | null;
  armsFailed: string;
  armsStatus: ArmsStatus;
  viewmodel: THREE.Group | null;
  damagePops: DamagePop[];
  lastTick: number;
};

const CLIP_ACTOR_LIMIT = 6;

function snapshotActors(world: {
  players: Map<string, THREE.Group>;
  realPlayers: Map<string, PlayerModel>;
  playerLoading: Set<string>;
  arms: ArmsViewmodel | null;
  armsId: string;
  armsLoading: string | null;
  armsFailed: string;
  armsStatus: ArmsStatus;
  viewmodel: THREE.Group | null;
  damagePops: DamagePop[];
  lastTick: number;
}): ClipActors {
  return {
    players: world.players,
    realPlayers: world.realPlayers,
    playerLoading: world.playerLoading,
    arms: world.arms,
    armsId: world.armsId,
    armsLoading: world.armsLoading,
    armsFailed: world.armsFailed,
    armsStatus: world.armsStatus,
    viewmodel: world.viewmodel,
    damagePops: world.damagePops,
    lastTick: world.lastTick,
  };
}

function hideActors(snap: ClipActors) {
  for (const rig of snap.players.values()) rig.visible = false;
  for (const model of snap.realPlayers.values()) model.root.visible = false;
  if (snap.arms) snap.arms.root.visible = false;
  if (snap.viewmodel) snap.viewmodel.visible = false;
}

function disposeActors(snap: ClipActors) {
  for (const rig of snap.players.values()) {
    rig.parent?.remove(rig);
    disposeObject(rig);
  }
  for (const model of snap.realPlayers.values()) {
    model.root.parent?.remove(model.root);
    disposePlayerModel(model);
  }
  if (snap.arms) {
    snap.arms.root.parent?.remove(snap.arms.root);
    disposeArmsViewmodel(snap.arms);
  }
  if (snap.viewmodel) {
    snap.viewmodel.parent?.remove(snap.viewmodel);
    disposeObject(snap.viewmodel);
  }
}

function poseBoundsFromDump(dump: PreviewDump) {
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const frame of dump.frames) {
    for (const pose of Object.values(frame.players)) {
      minX = Math.min(minX, pose.x);
      maxX = Math.max(maxX, pose.x);
      minY = Math.min(minY, pose.y);
      maxY = Math.max(maxY, pose.y);
      minZ = Math.min(minZ, pose.z);
      maxZ = Math.max(maxZ, pose.z);
    }
  }
  return { minX, maxX, minY, maxY, minZ, maxZ };
}

function disposeObject(obj: THREE.Object3D) {
  obj.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = mesh.material;
    if (!material) return;
    const list = Array.isArray(material) ? material : [material];
    for (const mat of list) mat.dispose();
  });
}

export const ClipStage = memo(function ClipStage({
  dump,
  clipId = null,
  kills,
  assets = null,
  assetsReady = true,
  vmPrefs = DEFAULT_VIEWMODEL,
  mapRev = 0,
  onMapStatus,
  onArmsStatus,
  ref,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    players: Map<string, THREE.Group>;
    viewmodel: THREE.Group | null;
    vmScene: THREE.Scene;
    vmCamera: THREE.PerspectiveCamera;
    motion: ViewmodelMotion;
    tracerPool: TracerPool;
    nadeFx: NadeFx;
    damageFx: DamageFx;
    damagePops: DamagePop[];
    casings: CasingPool;
    c4: WorldC4;
    c4Loading: boolean;
    lastTick: number;
    arms: ArmsViewmodel | null;
    armsId: string;
    armsLoading: string | null;
    armsFailed: string;
    realPlayers: Map<string, PlayerModel>;
    playerLoading: Set<string>;
    assets: AssetBundle | null;
    armsStatus: ArmsStatus;
    vmPrefs: ViewmodelPrefs;
    clipActors: Map<string, ClipActors>;
    activeClip: string;
    renderNow: () => void;
    playback: PlaybackIndex | null;
    playbackDump: PreviewDump | null;
    killLines: THREE.Line[];
    hudKey: string;
  } | null>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const [hud, setHud] = useState<StageHud | null>(null);
  const dumpRef = useRef(dump);
  dumpRef.current = dump;
  const killsRef = useRef(kills);
  killsRef.current = kills;
  const assetsRef = useRef(assets);
  assetsRef.current = assets;
  const assetsReadyRef = useRef(assetsReady);
  assetsReadyRef.current = assetsReady;
  const onArmsStatusRef = useRef(onArmsStatus);
  onArmsStatusRef.current = onArmsStatus;
  const seekRef = useRef<(tick: number) => void>(() => {});
  const pendingTick = useRef<number | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: false,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      host.replaceChildren();
      const note = document.createElement("div");
      note.className = "flex h-full items-center justify-center px-6 text-center text-sm text-muted";
      note.textContent = "Preview lost the GPU context. Switch to Low and reopen the clip.";
      host.appendChild(note);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
    renderer.setSize(host.clientWidth, host.clientHeight);
    renderer.setClearColor(0x10140f, 1);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x10140f, 1200, 9000);

    const camera = new THREE.PerspectiveCamera(75, host.clientWidth / Math.max(host.clientHeight, 1), 2, 20000);
    camera.rotation.order = "YXZ";
    scene.add(camera);

    scene.add(new THREE.HemisphereLight(0xc8d4e4, 0x2a2418, 1.05));
    const sun = new THREE.DirectionalLight(0xffe6c2, 1.2);
    sun.position.set(400, 900, 200);
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x445566, 0.45));

    // The viewmodel gets its own scene and camera so it is never clipped by
    // world geometry and its lighting does not change with the map.
    const vmScene = new THREE.Scene();
    // Near plane sits past the stretched clavicle/shoulder verts (z ≥ 0 in
    // the idle pose) so they cannot fill the lens. Hands and gun are ~12".
    const vmCamera = new THREE.PerspectiveCamera(54, camera.aspect, 6, 400);
    vmScene.add(new THREE.HemisphereLight(0xe8eef6, 0x3a3328, 1.35));
    const vmKey = new THREE.DirectionalLight(0xfff6ea, 1.55);
    vmKey.position.set(-8, 12, 10);
    vmScene.add(vmKey);
    vmScene.add(new THREE.AmbientLight(0x9aa6b4, 0.75));

    const tracerPool = makeTracerPool();
    scene.add(tracerPool.group);
    const nadeFx = makeNadeFx();
    scene.add(nadeFx.group);
    const damageFx = makeDamageFx();
    scene.add(damageFx.group);
    const casings = makeCasingPool();
    scene.add(casings.group);
    const c4 = makeWorldC4();
    scene.add(c4.group);

    const killLines = Array.from({ length: KILL_LINES }, () => {
      const line = makeKillLine();
      scene.add(line);
      return line;
    });

    const world = {
      renderer,
      scene,
      camera,
      players: new Map<string, THREE.Group>(),
      viewmodel: null as THREE.Group | null,
      vmScene,
      vmCamera,
      motion: makeViewmodelMotion(),
      tracerPool,
      nadeFx,
      damageFx,
      damagePops: [] as DamagePop[],
      casings,
      c4,
      c4Loading: false,
      lastTick: Number.NaN,
      arms: null as ArmsViewmodel | null,
      armsId: "",
      armsLoading: null as string | null,
      armsFailed: "",
      realPlayers: new Map<string, PlayerModel>(),
      playerLoading: new Set<string>(),
      assets: null as AssetBundle | null,
      armsStatus: "procedural" as ArmsStatus,
      vmPrefs,
      clipActors: new Map<string, ClipActors>(),
      activeClip: "",
      renderNow: () => {},
      playback: null as PlaybackIndex | null,
      playbackDump: null as PreviewDump | null,
      killLines,
      hudKey: "",
    };
    worldRef.current = world;

    const renderNow = () => {
      renderer.render(scene, camera);
      const vmVisible = Boolean(world.arms?.root.visible || world.viewmodel?.visible);
      if (vmVisible) {
        // Second pass over a cleared depth buffer keeps the gun in front of walls.
        renderer.autoClear = false;
        renderer.clearDepth();
        renderer.render(vmScene, vmCamera);
        renderer.autoClear = true;
      }
    };
    world.renderNow = renderNow;

    const onResize = () => {
      if (!host.clientWidth || !host.clientHeight) return;
      const aspect = host.clientWidth / host.clientHeight;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      vmCamera.aspect = aspect;
      vmCamera.updateProjectionMatrix();
      if (world.viewmodel) {
        placeViewmodel(world.viewmodel, vmCamera);
        seatViewmodel(world.viewmodel, world.vmPrefs);
      }
      if (world.arms) {
        placeArmsViewmodel(world.arms, vmCamera);
        seatViewmodel(world.arms.root, world.vmPrefs);
      }
      renderer.setSize(host.clientWidth, host.clientHeight);
      renderNow();
    };
    const observer = new ResizeObserver(onResize);
    observer.observe(host);
    renderNow();
    const queued = pendingTick.current;
    pendingTick.current = null;
    if (dumpRef.current) seekRef.current(queued ?? dumpRef.current.startTick);

    return () => {
      observer.disconnect();
      if (world.viewmodel) disposeObject(world.viewmodel);
      disposeArmsViewmodel(world.arms);
      for (const player of world.realPlayers.values()) disposePlayerModel(player);
      for (const snap of world.clipActors.values()) disposeActors(snap);
      for (const line of killLines) {
        line.geometry.dispose();
        (line.material as THREE.Material).dispose();
      }
      disposeTracerPool(world.tracerPool);
      disposeNadeFx(world.nadeFx);
      disposeDamageFx(world.damageFx);
      disposeCasingPool(world.casings);
      disposeWorldC4(world.c4);
      renderer.dispose();
      if (renderer.domElement.parentNode === host) host.removeChild(renderer.domElement);
      worldRef.current = null;
    };
  }, []);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const { scene } = world;
    const mapKey = dump ? `${dump.mapGltf ?? ""}|${dump.mapSource ?? ""}|${dump.radar?.image ?? ""}` : "";
    const old = scene.getObjectByName("mapRoot") as THREE.Group | undefined;
    if (old && dump?.frames.length && old.userData.mapKey === mapKey) {
      old.userData.poseBounds = poseBoundsFromDump(dump);
      return;
    }
    let keepMesh: THREE.Object3D | null = null;
    if (old) {
      const mesh = old.getObjectByName("mapMesh");
      if (mesh) {
        old.remove(mesh);
        keepMesh = mesh.userData.mapKey === mapKey ? mesh : null;
        if (mesh !== keepMesh) {
          const plane = mesh.getObjectByName("radarPlane");
          if (plane) {
            mesh.remove(plane);
            disposeObject(plane);
          }
        }
      }
      disposeObject(old);
      scene.remove(old);
    }
    if (!dump?.frames.length) return;

    const { minX, maxX, minY, maxY, minZ, maxZ } = poseBoundsFromDump(dump);
    const pad = 900;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const width = Math.max(400, maxX - minX + pad * 2);
    const depth = Math.max(400, maxY - minY + pad * 2);
    const groundZ = Number.isFinite(minZ) ? minZ - 4 : 0;
    const center = cs2ToThree(cx, cy, groundZ);

    const root = new THREE.Group();
    root.name = "mapRoot";
    root.userData.mapKey = mapKey;

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(width, 8, depth),
      new THREE.MeshStandardMaterial({ color: 0x3a4a32, roughness: 0.92, metalness: 0.04 }),
    );
    ground.name = "fallbackGround";
    ground.position.set(center.x, center.y - 4, center.z);
    root.add(ground);

    const grid = new THREE.GridHelper(Math.max(width, depth), 24, 0x5a6a48, 0x2c3428);
    grid.name = "fallbackGrid";
    grid.position.copy(ground.position);
    root.add(grid);
    root.userData.poseBounds = { minX, maxX, minY, maxY, minZ, maxZ };

    scene.add(root);
    if (keepMesh) {
      keepMesh.name = "mapMesh";
      root.add(keepMesh);
      ground.visible = false;
      grid.visible = false;
    }
  }, [dump?.startTick, dump?.endTick, dump?.frames.length, dump?.povSteamid, dump?.mapGltf, dump?.mapSource, dump?.radar?.image]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world || !dump) return;
    const root = world.scene.getObjectByName("mapRoot") as THREE.Group | undefined;
    if (!root) return;
    const bounds = root.userData.poseBounds as
      | { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
      | undefined;
    if (!bounds) return;
    const ground = root.getObjectByName("fallbackGround") as THREE.Mesh | undefined;
    const grid = root.getObjectByName("fallbackGrid");
    const meshSources = dump.mapSource === "collision" || dump.mapSource === "radar";
    if (!dump.mapGltf || !meshSources) return;
    const mapPath = dump.mapGltf;
    retainGltf(mapPath);

    const mapKey = `${dump.mapGltf}|${dump.mapSource}|${dump.radar?.image ?? ""}`;
    const existing = root.getObjectByName("mapMesh");
    if (existing?.userData.mapKey === mapKey) {
      onMapStatus?.("ready");
      return () => releaseGltf(mapPath);
    }

    const hadMesh = Boolean(existing);
    if (!hadMesh) onMapStatus?.("loading");

    let cancelled = false;
    const source = dump.mapSource;
    const radar = dump.radar;
    const { minX, maxX, minY, maxY, minZ, maxZ } = bounds;
    loadMapGltf(mapPath).then(async (loaded) => {
      if (cancelled || worldRef.current?.scene !== world.scene) {
        if (loaded && !isCachedMapMesh(loaded)) disposeObject(loaded);
        return;
      }
      if (!loaded) {
        if (!hadMesh) onMapStatus?.("failed");
        return;
      }
      if (loaded.parent) loaded.parent.remove(loaded);
      let mesh: THREE.Object3D = loaded;
      let fitted = false;
      const poseBox = poseBoundsToThree({ minX, maxX, minY, maxY, minZ, maxZ });
      if (source === "radar" && radar) {
        // Clone the hierarchy only. Sharing geometry avoids a second copy of the
        // collision hull, which is what blew the D3D11 budget (GL_OUT_OF_MEMORY).
        mesh = loaded.clone(true);
        mesh.userData.cached = false;
        mesh.traverse((child) => {
          if (child.userData) delete child.userData.cached;
        });
        const fit = fitMapMesh(mesh, poseBox);
        if (fit === "mismatch") {
          if (!hadMesh) onMapStatus?.("mismatch");
          return;
        }
        fitted = true;
        const tex = await loadRadarTexture(radar.image);
        if (cancelled || worldRef.current?.scene !== world.scene) return;
        if (tex) applyRadarTintShader(mesh, radar, tex);
        const upper = await loadRadarRaster(radar.image);
        if (cancelled || worldRef.current?.scene !== world.scene) return;
        if (upper) {
          const plane = await makeRadarPlane(radar, upper, poseBox.min.y + 1);
          if (cancelled || worldRef.current?.scene !== world.scene) return;
          if (plane) mesh.add(plane);
        }
      } else {
        flattenMaterials(loaded);
      }
      mesh.name = "mapMesh";
      mesh.userData.mapKey = mapKey;
      if (!fitted) {
        const fit = fitMapMesh(mesh, poseBox);
        if (fit === "mismatch") {
          console.warn(
            `[preview] map mesh does not overlap the clip. mesh ${describeBox(
              new THREE.Box3().setFromObject(mesh),
            )} poses ${describeBox(poseBox)}`,
          );
          if (!hadMesh) onMapStatus?.("mismatch");
          return;
        }
      }
      const prev = root.getObjectByName("mapMesh");
      if (prev && prev !== mesh) {
        const plane = prev.getObjectByName("radarPlane");
        if (plane) {
          prev.remove(plane);
          disposeObject(plane);
        }
        if (isCachedMapMesh(prev)) root.remove(prev);
        else root.remove(prev);
      }
      if (mesh.parent !== root) root.add(mesh);
      if (ground) ground.visible = false;
      if (grid) grid.visible = false;
      world.renderNow();
      onMapStatus?.("ready");
    });

    return () => {
      cancelled = true;
      releaseGltf(mapPath);
    };
  }, [dump?.mapGltf, dump?.mapSource, dump?.radar?.image, mapRev, onMapStatus]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    const prevFov = world.vmPrefs.fov;
    world.vmPrefs = vmPrefs;
    if (Math.abs(world.vmCamera.fov - vmPrefs.fov) > 0.05) {
      world.vmCamera.fov = vmPrefs.fov;
      world.vmCamera.updateProjectionMatrix();
    }
    const replace = Math.abs(prevFov - vmPrefs.fov) > 0.05;
    if (world.arms) {
      if (replace) placeArmsViewmodel(world.arms, world.vmCamera);
      seatViewmodel(world.arms.root, vmPrefs);
    }
    if (world.viewmodel) {
      if (replace) placeViewmodel(world.viewmodel, world.vmCamera);
      seatViewmodel(world.viewmodel, vmPrefs);
    }
  }, [vmPrefs]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world) return;
    world.assets = assets ?? null;
    // A later wave adds paths; keep a working viewmodel and retry anything that failed.
    world.armsFailed = "";
    if (assets && dump) {
      const kinds = [...new Set((dump.grenades ?? []).map((nade) => nade.kind).filter(Boolean))];
      bindNadeModels(world.nadeFx, assets, kinds.length ? kinds : ["he", "flash", "smoke", "molotov", "decoy"]);
    }
  }, [assets, dump?.startTick, dump?.grenades]);

  useEffect(() => {
    const world = worldRef.current;
    if (world && dump) world.damagePops = damagePopsForDump(dump);
  }, [dump]);

  useEffect(() => {
    const world = worldRef.current;
    if (!world || !clipId) return;
    if (world.activeClip === clipId) return;

    if (world.activeClip) {
      const snap = snapshotActors(world);
      hideActors(snap);
      world.clipActors.set(world.activeClip, snap);
    }

    const hit = world.clipActors.get(clipId);
    if (hit) {
      world.clipActors.delete(clipId);
      world.players = hit.players;
      world.realPlayers = hit.realPlayers;
      world.playerLoading = hit.playerLoading;
      world.arms = hit.arms;
      world.armsId = hit.armsId;
      world.armsLoading = hit.armsLoading;
      world.armsFailed = hit.armsFailed;
      world.armsStatus = hit.armsStatus;
      world.viewmodel = hit.viewmodel;
      world.damagePops = hit.damagePops;
      world.lastTick = Number.NaN;
      world.activeClip = clipId;
      onArmsStatus?.(hit.armsStatus);
      return;
    }

    world.players = new Map();
    world.realPlayers = new Map();
    world.playerLoading = new Set();
    world.arms = null;
    world.armsId = "";
    world.armsLoading = null;
    world.armsFailed = "";
    world.armsStatus = "procedural";
    world.viewmodel = null;
    world.damagePops = [];
    world.lastTick = Number.NaN;
    world.activeClip = clipId;

    while (world.clipActors.size >= CLIP_ACTOR_LIMIT) {
      const oldest = world.clipActors.keys().next().value as string | undefined;
      if (!oldest) break;
      const evicted = world.clipActors.get(oldest);
      world.clipActors.delete(oldest);
      if (evicted) disposeActors(evicted);
    }
  }, [clipId, onArmsStatus]);

  seekRef.current = (tick: number) => {
    const world = worldRef.current;
    const dump = dumpRef.current;
    const assets = assetsRef.current;
    const assetsReady = assetsReadyRef.current;
    const kills = killsRef.current;
    if (!world || !dump) {
      pendingTick.current = tick;
      return;
    }
    const { scene, camera, players } = world;
    const pov = dump.povSteamid;
    const seen = new Set<string>();
    const frame = dump.frames[0];
    const ids = frame ? Object.keys(frame.players) : [];

    // Scrubbing jumps arbitrarily, so a backward or huge jump contributes no
    // time rather than winding the walk cycle and weapon bob forward.
    const prevTick = world.lastTick;
    const rawDt = Number.isFinite(prevTick) ? (tick - prevTick) / Math.max(dump.tickrate, 1) : 0;
    const frameDt = rawDt > 0 && rawDt < 0.5 ? rawDt : 0;
    world.lastTick = tick;

    const playback =
      world.playbackDump === dump && world.playback ? world.playback : indexDump(dump);
    world.playback = playback;
    world.playbackDump = dump;
    const wide = shotsInWindowIndexed(
      playback,
      tick,
      dump.tickrate,
      Math.max(CASING_WINDOW_SECONDS, 0.3),
    );
    const recentShots = narrowShotWindow(wide, tick, dump.tickrate, 0.3);

    for (const steamid of ids) {
      if (steamid === pov) continue;
      seen.add(steamid);
      const pose = poseAtIndexed(playback, tick, steamid);
      if (!pose) continue;
      const real = world.realPlayers.get(steamid);
      if (!real && assets && assetsReady && !world.playerLoading.has(steamid)) {
        world.playerLoading.add(steamid);
        const team = pose.team;
        makePlayerModel(assets, team).then((model) => {
          if (worldRef.current !== world || world.assets !== assets) {
            disposePlayerModel(model);
            return;
          }
          world.playerLoading.delete(steamid);
          if (!model) return;
          const existing = players.get(steamid);
          if (existing) {
            scene.remove(existing);
            disposeObject(existing);
            players.delete(steamid);
          }
          world.realPlayers.set(steamid, model);
          scene.add(model.root);
          world.renderNow();
        });
      }

      if (real) {
        const vel = velocityAtIndexed(playback, tick, steamid, dump.tickrate);
        const info = resolveWeapon(pose.weapon);
        void setPlayerWeapon(real, assets, pose.weapon, skinKey(pose.weapon, pose.skin, pose.paintKit));
        const own = recentShots.filter((shot) => shot.steamid === steamid);
        const last = own[own.length - 1];
        const shotAge = last ? (tick - last.tick) / Math.max(dump.tickrate, 1) : null;
        const died = deathAgeIndexed(playback, tick, steamid, dump.tickrate);
        updatePlayerModel(real, {
          tick,
          tickrate: dump.tickrate,
          dt: frameDt,
          yaw: pose.yaw,
          pitch: pose.pitch,
          duck: pose.duck ?? (pose.ducking ? 1 : 0),
          alive: pose.alive,
          deathAge: died,
          walking: pose.walking,
          velX: vel.x,
          velY: vel.y,
          shotAge,
          reload: reloadProgressIndexed(playback, tick, dump.tickrate, steamid, real.weapon?.reloadSeconds ?? 2.4),
          info,
        });
        const p = cs2ToThree(pose.x, pose.y, pose.z);
        real.root.position.set(p.x, p.y, p.z);
        real.root.rotation.copy(cs2BodyEuler(pose.yaw));
        real.root.visible = true;
        continue;
      }

      let rig = players.get(steamid);
      if (!rig) {
        rig = makePlayerRig(pose.team);
        players.set(steamid, rig);
        scene.add(rig);
      }
      setRigWeapon(rig, pose.weapon);
      const died = deathAgeIndexed(playback, tick, steamid, dump.tickrate);
      const fall = pose.alive ? 0 : Math.min(1, (died ?? 10) / 0.45);
      const fadeKey = pose.alive ? "alive" : fall.toFixed(2);
      if (rig.userData.fadeKey !== fadeKey) {
        rig.userData.fadeKey = fadeKey;
        rig.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const mat = mesh.material as THREE.MeshLambertMaterial;
          if (!mat) return;
          mat.opacity = pose.alive ? 1 : 1 - 0.6 * fall;
          mat.transparent = !pose.alive;
        });
      }
      const p = cs2ToThree(pose.x, pose.y, pose.z);
      rig.position.set(p.x, p.y, p.z);
      rig.rotation.copy(cs2BodyEuler(pose.yaw));
      setRigDucking(rig, pose.duck ?? (pose.ducking ? 1 : 0));
      setRigDead(rig, !pose.alive, died ?? 10);
      aimRig(rig, pose.alive ? pose.pitch : 0);
      animateRig(rig, pose.alive ? velocityAtIndexed(playback, tick, steamid, dump.tickrate).speed : 0, frameDt);
      rig.visible = true;
    }
    for (const [id, rig] of players) {
      if (!seen.has(id)) rig.visible = false;
    }
    for (const [id, model] of world.realPlayers) {
      if (!seen.has(id)) model.root.visible = false;
    }

    const self = poseAtIndexed(playback, tick, pov);
    if (self) {
      const eye = cs2ToThree(self.x, self.y, self.z + eyeHeight(self));
      camera.position.set(eye.x, eye.y, eye.z);
      // The punch is added on top of the verified base aim, never folded into it.
      const punch = punchAt(self, dump.tickrate);
      camera.rotation.copy(cs2ViewEuler(self.pitch + punch.pitch, self.yaw + punch.yaw));

      const wantFov = scopedFov(self.scoped, zoomAgeIndexed(playback, tick, dump.tickrate, pov));
      if (Math.abs(camera.fov - wantFov) > 0.05) {
        camera.fov = wantFov;
        camera.updateProjectionMatrix();
      }

      const info = resolveWeapon(self.weapon);
      const kind = weaponKind(self.weapon);
      const agent = AGENT_BY_TEAM[self.team] ?? FALLBACK_AGENT;
      const painted = skinKey(self.weapon, self.skin, self.paintKit);
      const armsToken = `${info.id}:${painted}`;
      if (
        assets &&
        world.armsId !== armsToken &&
        world.armsLoading !== armsToken &&
        world.armsFailed !== armsToken
      ) {
        world.armsLoading = armsToken;
        makeArmsViewmodel(assets, agent, info, self.team, painted).then((vm) => {
          if (worldRef.current !== world || world.armsLoading !== armsToken) {
            disposeArmsViewmodel(vm);
            return;
          }
          world.armsLoading = null;
          if (!vm) {
            world.armsFailed = armsToken;
            return;
          }
          if (world.arms) {
            world.vmScene.remove(world.arms.root);
            disposeArmsViewmodel(world.arms);
          }
          if (!placeArmsViewmodel(vm, world.vmCamera)) {
            disposeArmsViewmodel(vm);
            world.armsFailed = armsToken;
            return;
          }
          seatViewmodel(vm.root, world.vmPrefs);
          attachMuzzleFlash(vm.weapon?.muzzle ?? vm.root);
          world.arms = vm;
          world.armsId = armsToken;
          world.vmScene.add(vm.root);
          if (world.viewmodel) world.viewmodel.visible = false;
          world.renderNow();
        });
      }

      // Kick and flash are read off the last POV shot's age, so they are a pure
      // function of the playhead and stay correct while scrubbing.
      const recoilShots = narrowShotWindow(wide, tick, dump.tickrate, RECOIL_SECONDS);
      const own = recoilShots.filter((shot) => shot.steamid === pov);
      const last = own[own.length - 1];
      const shotAge = last ? (tick - last.tick) / Math.max(dump.tickrate, 1) : Infinity;
      const nadeThrow =
        throwAgeIndexed(playback, tick, dump.tickrate, pov) ??
        throwAgeFromGrenades(dump.grenades, tick, dump.tickrate, self.weapon);
      const reload = reloadProgressIndexed(
        playback,
        tick,
        dump.tickrate,
        pov,
        world.arms?.weapon?.reloadSeconds ?? 2.4,
      );
      const equip = lastEquipIndexed(playback, tick, pov);
      const drawAge =
        equip && resolveWeapon(equip.item ?? "").id === info.id
          ? (tick - equip.tick) / Math.max(dump.tickrate, 1)
          : null;

      const hideVm = !self.alive || (self.scoped && weaponCanScope(self.weapon));
      if (world.arms) {
        world.arms.root.visible = !hideVm;
        updateArmsViewmodel(world.arms, {
          shotAge: Number.isFinite(shotAge) ? shotAge : null,
          throwAge: nadeThrow,
          reload,
          drawAge,
          speed: velocityAtIndexed(playback, tick, pov, dump.tickrate).speed,
          walking: self.walking,
          dt: frameDt,
          yaw: self.yaw,
          pitch: self.pitch,
        });
        pulseMuzzleFlash(world.arms.weapon?.muzzle ?? world.arms.root, Math.max(0, 1 - shotAge / MUZZLE_SECONDS), info.silenced);
        if (world.viewmodel) world.viewmodel.visible = false;
      } else {
        if (!world.viewmodel || world.viewmodel.userData.kind !== kind) {
          if (world.viewmodel) {
            world.vmScene.remove(world.viewmodel);
            disposeObject(world.viewmodel);
          }
          world.viewmodel = makeViewmodelRig(self.weapon);
          world.vmScene.add(world.viewmodel);
          placeViewmodel(world.viewmodel, world.vmCamera);
          seatViewmodel(world.viewmodel, world.vmPrefs);
        }
        world.viewmodel.visible = !hideVm;
        animateViewmodel(world.viewmodel, world.motion, {
          speed: velocityAtIndexed(playback, tick, pov, dump.tickrate).speed,
          yaw: self.yaw,
          pitch: self.pitch,
          dt: frameDt,
          recoil: Math.max(0, 1 - shotAge / RECOIL_SECONDS),
          muzzle: Math.max(0, 1 - shotAge / MUZZLE_SECONDS),
          walking: self.walking,
        });
      }
    }

    // Every player's gunfire, not just the POV's, so incoming fire is visible.
    updateTracers(
      world.tracerPool,
      narrowShotWindow(wide, tick, dump.tickrate, TRACER_WINDOW_SECONDS),
      tick,
      dump.tickrate,
      pov,
    );
    updateCasings(world.casings, wide, tick, dump.tickrate, assets);
    if (
      assets &&
      assetsReady &&
      !world.c4.real &&
      !world.c4Loading &&
      bundleWeaponPath(assets, resolveWeapon("c4").model)
    ) {
      world.c4Loading = true;
      void bindWorldC4Model(world.c4, assets).finally(() => {
        if (worldRef.current === world) {
          world.c4Loading = false;
          world.renderNow();
        }
      });
    }
    updateWorldC4(world.c4, dump.bombs, tick);
    updateNadeFx(
      world.nadeFx,
      {
        grenades: dump.grenades ?? [],
        smokes: dump.smokes ?? [],
        fires: dump.fires ?? [],
        bursts: dump.bursts ?? [],
      },
      tick,
      dump.tickrate,
    );
    updateDamageFx(world.damageFx, world.damagePops, tick, dump.tickrate);

    let slot = 0;
    const fade = dump.tickrate * 0.45;
    for (const kill of kills) {
      if (slot >= world.killLines.length) break;
      if (kill.tick > tick || tick - kill.tick > fade) continue;
      const atk = poseAtIndexed(playback, kill.tick, kill.attackerSteamid);
      const vic = poseAtIndexed(playback, kill.tick, kill.victimSteamid);
      if (!atk || !vic) continue;
      const a = cs2ToThree(atk.x, atk.y, atk.z + eyeHeight(atk));
      const b = cs2ToThree(vic.x, vic.y, vic.z + eyeHeight(vic) * 0.8);
      const line = world.killLines[slot];
      const attr = line.geometry.getAttribute("position") as THREE.BufferAttribute;
      attr.setXYZ(0, a.x, a.y, a.z);
      attr.setXYZ(1, b.x, b.y, b.z);
      attr.needsUpdate = true;
      line.visible = true;
      slot += 1;
    }
    for (; slot < world.killLines.length; slot += 1) world.killLines[slot].visible = false;
    const nextStatus: ArmsStatus = world.arms ? "real" : world.armsFailed ? "failed" : "procedural";
    if (world.armsStatus !== nextStatus) {
      world.armsStatus = nextStatus;
      onArmsStatusRef.current?.(nextStatus);
    }
    const flashed = self?.alive ? flashAtIndexed(playback, tick, dump.tickrate, pov) : 0;
    if (flashRef.current) flashRef.current.style.opacity = String(flashed > 0.01 ? flashed : 0);
    const nextHud: StageHud | null = self
      ? {
          alive: self.alive,
          scoped: self.alive && Boolean(self.scoped) && weaponCanScope(self.weapon),
          weapon: self.weapon,
          health: Math.max(0, Math.round(self.health)),
          armor: Math.max(0, Math.round(self.armor)),
          place: self.place ?? "",
          team: self.team,
        }
      : null;
    const key = nextHud ? hudKey(nextHud) : "";
    if (world.hudKey !== key) {
      world.hudKey = key;
      setHud(nextHud && self ? { ...nextHud, pose: self } : null);
    }
    world.renderNow();
  };

  useImperativeHandle(
    ref,
    () => ({
      seek(tick: number) {
        seekRef.current(tick);
      },
    }),
    [],
  );

  useEffect(() => {
    const current = dumpRef.current;
    if (!current) return;
    const world = worldRef.current;
    const tick = world && Number.isFinite(world.lastTick) ? world.lastTick : current.startTick;
    seekRef.current(tick);
  }, [dump, assets, assetsReady, kills, clipId, vmPrefs, mapRev]);

  const povAlive = hud?.alive ?? false;
  const scoped = hud?.scoped ?? false;

  return (
    <div className="relative h-full min-h-[280px] w-full overflow-hidden rounded-xl bg-ink">
      <div ref={hostRef} className="absolute inset-0" />
      {scoped && <ScopeOverlay />}
      {povAlive && !scoped && <Crosshair />}
      {hud?.pose && povAlive && <PovHud pose={hud.pose} team={hud.team} />}
      <div
        ref={flashRef}
        className="pointer-events-none absolute inset-0 z-30 bg-white"
        style={{ opacity: 0 }}
      />
    </div>
  );
});

export class ClipStageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ClipStage crashed", error, info);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted">
          Preview lost the GPU context. Switch to Low and pick the clip again.
        </div>
      );
    }
    return this.props.children;
  }
}
