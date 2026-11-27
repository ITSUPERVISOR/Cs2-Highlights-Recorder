/**
 * Assert the extracted CS2 models against the real exports in the asset cache.
 *
 * These are the failures that are silent or invisible until the whole viewmodel
 * looks wrong: a gun 40x too small, a barrel pointing at the player, a muzzle
 * flash hanging in space beside the weapon, or a hand pose that never applied
 * because the animation name was one character off.
 *
 *   npx tsx scripts/check-game-assets.mts
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { instantiate, meshBounds, findClip, METRES_TO_INCHES } from "../src/renderer/src/lib/gameAssets";
import {
  applyBlendedPose,
  collectBones,
  extractPose,
  gripBounds,
  hideMesh,
  placeArmsViewmodel,
  poseBoneNames,
  ARMS_MESHES,
  BODY_MESH,
  PLACEHOLDER_MESH,
} from "../src/renderer/src/lib/armsViewmodel";
import { tipCentroid } from "../src/renderer/src/lib/weaponModels";
import { WEAPONS, resolveWeapon, casingModel, allWeaponModels } from "../src/renderer/src/lib/weaponTable";
import {
  viewmodelAnims,
  locomotionAnims,
  SHARED_ANIMS,
  AGENT_BY_TEAM,
  FALLBACK_AGENT,
  buildPriorityAssetSpec,
  buildWarmAssetSpec,
} from "../src/renderer/src/lib/assetSpec";

const cache = join(process.env.LOCALAPPDATA ?? "", "cs2-reel", "assets");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL ${label}${detail ? `  (${detail})` : ""}`);
  }
}

function loadGlb(path: string) {
  const bytes = readFileSync(path);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const loader = new GLTFLoader();
  return new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
    loader.parse(buf, "", (gltf) => resolve({ scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] }), reject);
  });
}

// ---------------------------------------------------------------- weapon table

console.log("\nweapon table");
{
  const cases: [string, string][] = [
    ["Desert Eagle", "deagle"],
    ["weapon_deagle", "deagle"],
    ["SSG 08", "ssg08"],
    ["M4A1-S", "m4a1_silencer"],
    ["USP-S", "usp_silencer"],
    ["Glock-18", "glock18"],
    ["Nomad Knife", "knife_outdoor"],
    ["weapon_knife_t", "knife_default_t"],
    ["CZ75-Auto", "cz75a"],
    ["Zeus x27", "taser"],
    ["High Explosive Grenade", "hegrenade"],
    ["Smoke Grenade", "smokegrenade"],
  ];
  for (const [raw, id] of cases) {
    const got = resolveWeapon(raw).id;
    check(`resolve ${raw}`, got === id, `-> ${got}`);
  }
  // The bug this table exists to fix.
  check("Desert Eagle is a pistol", resolveWeapon("Desert Eagle").kind === "pistol");
  check("SSG 08 is a sniper", resolveWeapon("SSG 08").kind === "sniper");
  check("unknown weapon degrades", resolveWeapon("Plasma Rifle 3000").kind === "rifle");
  check("unknown knife stays a knife", resolveWeapon("Gamma Doppler Knife").kind === "knife");

  const noModel = Object.values(WEAPONS).filter((w) => !w.model);
  check("every weapon has a model path", noModel.length === 0, `${noModel.length} without`);
  const casings = Object.values(WEAPONS).filter((w) => w.casing && !casingModel(w));
  check("casing paths resolve", casings.length === 0);
}

// --------------------------------------------------------------- weapon models

console.log("\nweapon models");
const weaponChecks: [string, number, number][] = [
  // id, min inches, max inches
  ["ak47", 30, 42],
  ["deagle", 8, 16],
];
for (const [id, lo, hi] of weaponChecks) {
  const info = WEAPONS[id];
  const path = join(cache, "weapons", "models", `${info.model}.glb`);
  if (!existsSync(path)) {
    console.log(`  skip ${id}: not exported yet (${path})`);
    continue;
  }
  const loaded = await loadGlb(path);
  const { root, model } = instantiate(loaded);
  const bounds = meshBounds(root);
  const length = bounds.max.z - bounds.min.z;
  check(`${id} length in inches`, length > lo && length < hi, `${length.toFixed(1)} in`);
  check(`${id} scale factor applied`, Math.abs(root.scale.x - METRES_TO_INCHES) < 1e-6);
  // After the flip the barrel must run toward -Z, which is forward for every rig.
  check(`${id} barrel points -Z`, Math.abs(bounds.min.z) > Math.abs(bounds.max.z), `z ${bounds.min.z.toFixed(1)}..${bounds.max.z.toFixed(1)}`);
  check(`${id} low LOD pruned`, (() => {
    let legacyVisible = false;
    model.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh && m.name.endsWith("body_legacy") && m.visible) legacyVisible = true;
    });
    return !legacyVisible;
  })());
  const shoot = findClip(loaded.animations, "shoot");
  const reload = findClip(loaded.animations, "reload");
  check(`${id} shoot has real motion`, Boolean(shoot && shoot.duration > 0), shoot ? `${shoot.duration.toFixed(3)}s` : "missing");
  check(`${id} reload has real motion`, Boolean(reload && reload.duration > 0), reload ? `${reload.duration.toFixed(3)}s` : "missing");
}

// ------------------------------------------------------------------- the agent

console.log("\nagent arms and poses");
{
  const agent = "ctm_sas";
  const path = join(cache, "agents", "models", agent, `${agent}.glb`);
  if (!existsSync(path)) {
    console.log(`  skip ${agent}: not exported yet (${path})`);
  } else {
    const loaded = await loadGlb(path);
    const names = new Set<string>();
    loaded.scene.traverse((c) => names.add(c.name));
    for (const bone of ["wpn", "wpnPivot", "hand_R", "hand_L", "head_0", "finger_index_0_R"]) {
      check(`bone ${bone} present`, names.has(bone));
    }
    for (const mesh of [...ARMS_MESHES, BODY_MESH]) {
      check(`mesh ${mesh} present`, [...names].some((n) => n.includes(mesh)));
    }

    const idle = findClip(loaded.animations, "idle_ak");
    check("idle_ak clip present", Boolean(idle));
    if (idle) {
      const pose = extractPose(idle);
      check("idle_ak poses many bones", pose.size > 50, `${pose.size} bones`);
      const posed = poseBoneNames(pose);
      check("idle_ak poses the hands", posed.includes("hand_R") && posed.includes("hand_L"));
      check("idle_ak poses fingers", posed.filter((n) => n.startsWith("finger")).length > 20);
      check("idle_ak poses the weapon bone", posed.includes("wpn"));

      // Where the posed skeleton actually puts things, relative to the eye. This
      // is the check that catches arms behind the camera, upside down or off to
      // one side: invisible in the data and glaring on screen.
      const { root, model } = instantiate(loaded, { flipForward: true });
      const bones = collectBones(model);
      applyBlendedPose(bones, pose, null, 0);
      model.updateMatrixWorld(true);

      const vm = {
        root,
        model,
        bones,
        wpnBone: bones.get("wpn") ?? null,
        headBone: bones.get("head_0") ?? null,
        poses: { idle: pose, shoot: null, reload: null, draw: null },
        weapon: null,
        info: WEAPONS.ak47,
        bobPhase: 0,
        swayYaw: Number.NaN,
        swayPitch: Number.NaN,
      };
      const cam = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 400);
      check("placeArmsViewmodel", placeArmsViewmodel(vm, cam));

      const at = (name: string) => {
        const bone = bones.get(name);
        return bone ? bone.getWorldPosition(new THREE.Vector3()) : null;
      };
      const fmt = (v: THREE.Vector3 | null) =>
        v ? `x ${v.x.toFixed(1)} y ${v.y.toFixed(1)} z ${v.z.toFixed(1)}` : "missing";
      for (const name of ["wpn", "hand_R", "hand_L"]) {
        console.log(`  info ${name.padEnd(8)} ${fmt(at(name))} (inches from eye)`);
      }

      const wpn = at("wpn");
      const handR = at("hand_R");
      const handL = at("hand_L");
      check("weapon bone is in front of the eye", Boolean(wpn && wpn.z < 0), fmt(wpn));
      check(
        "weapon bone is within arm's reach",
        Boolean(wpn && wpn.length() > 4 && wpn.length() < 48),
        wpn ? `${wpn.length().toFixed(1)} in` : "missing",
      );
      check("right hand is in front of the eye", Boolean(handR && handR.z < 0), fmt(handR));
      check("right hand is below the eye", Boolean(handR && handR.y < 0), fmt(handR));
      check(
        "support hand is ahead of the trigger hand",
        Boolean(handL && handR && handL.z < handR.z),
        handL && handR ? `${handL.z.toFixed(1)} vs ${handR.z.toFixed(1)}` : "missing",
      );

      // The sleeves must ride the arm chain, not the spine, or they render far
      // above the camera and out of frame. This also catches the third-person
      // body failing to hide, which puts a whole character in front of the lens.
      hideMesh(model, BODY_MESH);
      hideMesh(model, PLACEHOLDER_MESH);
      const box = gripBounds(vm);
      console.log(
        `  info grip bounds y ${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)}  z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}`,
      );
      check("grip is below the eye", box.max.y < 8 && box.min.y > -20, `y ${box.min.y.toFixed(1)}..${box.max.y.toFixed(1)}`);
      check("grip is in front", box.min.z < 0, `z ${box.min.z.toFixed(1)}..${box.max.z.toFixed(1)}`);

      // Parenting the gun to the `wpn` bone assumes the bone's frame is the one
      // the weapon model was authored in, so no offset is needed. If that were
      // wrong the gun would float somewhere off in space, so it is measured.
      const akPath = join(cache, "weapons", "models", `${WEAPONS.ak47.model}.glb`);
      if (existsSync(akPath) && vm.wpnBone) {
        const ak = await loadGlb(akPath);
        const attached = instantiate(ak, { flipForward: false, scale: 1 });
        // Mirrors makeWeaponModel: measure the tip, then hang an empty there so
        // the world position stays right through the bone chain.
        const tip = tipCentroid(attached.root, meshBounds(attached.root), 1);
        const marker = new THREE.Object3D();
        marker.position.copy(attached.model.worldToLocal(tip.clone()));
        attached.model.add(marker);
        vm.wpnBone.add(attached.root);
        root.updateMatrixWorld(true);
        const muzzle = marker.getWorldPosition(new THREE.Vector3());
        console.log(`  info muzzle   ${fmt(muzzle)} (inches from eye)`);
        check("attached gun sits near the hands", muzzle.length() < 60, `${muzzle.length().toFixed(1)} in`);
        check("muzzle is in front of the eye", muzzle.z < 0, fmt(muzzle));
        check(
          "muzzle is ahead of the support hand",
          Boolean(handL && muzzle.z < handL.z),
          handL ? `${muzzle.z.toFixed(1)} vs ${handL.z.toFixed(1)}` : "missing",
        );
      }
    }
  }
}

// ------------------------------------------------- animation name construction

console.log("\nanimation names");
{
  const ak = viewmodelAnims(WEAPONS.ak47);
  check("ak viewmodel anims built", ak.length === 4, ak.map((n) => n.split("/").pop()).join(","));
  check(
    "ak idle path is correct",
    ak.includes("animation/anims/viewmodel/rifle/rifle_ak/idle_ak"),
  );
  // The irregular ones: a wrong name here exports nothing and silently unposes a hand.
  check("glock uses idle_glock", viewmodelAnims(WEAPONS.glock18).includes("animation/anims/viewmodel/pistol/pistol_glock18/idle_glock"));
  check("g3sg1 uses idle1_", viewmodelAnims(WEAPONS.g3sg1).includes("animation/anims/viewmodel/rifle/rifle_g3sg1/idle1_g3sg1"));
  check("m249 uses idle1_", viewmodelAnims(WEAPONS.m249).includes("animation/anims/viewmodel/rifle/rifle_m249/idle1_m249"));
  check("smoke uses idle_smoke", viewmodelAnims(WEAPONS.smokegrenade).includes("animation/anims/viewmodel/grenade/grenade_smokegrenade/idle_smoke"));
  check("default_t knife", viewmodelAnims(WEAPONS.knife_default_t).includes("animation/anims/viewmodel/knife/knife_default_t/idle_default_t"));
  check("elite has no shoot pose", viewmodelAnims(WEAPONS.elite).every((n) => !n.includes("shoot")));
  const tPov = buildPriorityAssetSpec({
    povSteamid: "1",
    frames: [{ tick: 1, players: { "1": { weapon: "ak47", team: "T" } } }],
  } as Parameters<typeof buildPriorityAssetSpec>[0]);
  check("T POV exports Phoenix", Boolean(tPov.agents[AGENT_BY_TEAM.T]?.length));
  check("T POV still gets SAS viewmodel fallback", Boolean(tPov.agents[FALLBACK_AGENT]?.length));

  const warm = buildWarmAssetSpec();
  check("warm cache lists every weapon mesh", warm.weapons.length >= allWeaponModels().length);
  check("warm cache includes SAS viewmodel idles", (warm.agents[FALLBACK_AGENT] ?? []).some((n) => n.includes("/idle_ak")));
  check("warm cache includes Phoenix locomotion", (warm.agents[AGENT_BY_TEAM.T] ?? []).some((n) => n.includes("/run_n_rifle")));

  check("locomotion is 26 clips", locomotionAnims("rifle").length === 26);
  check("locomotion covers 8 directions", locomotionAnims("rifle").filter((n) => n.includes("/run_")).length === 8);
  check("shared anims include breathing", SHARED_ANIMS.some((n) => n.endsWith("breathing")));
}

console.log(failures ? `\n${failures} FAILED\n` : "\nall checks passed\n");
process.exit(failures ? 1 : 0);


