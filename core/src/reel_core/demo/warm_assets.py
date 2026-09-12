"""Prefetch every Preview gun plus SAS/Phoenix locomotion (no 4K materials).

Model paths are the same strings as ``weaponTable.ts`` SPECS. A missing row
here only means that gun waits until a clip asks for it; it does not break
clip-scoped export.
"""

from __future__ import annotations

DIRECTIONS = ("n", "ne", "e", "se", "s", "sw", "w", "nw")
WORLD = ("rifle", "pistol", "knife")
FALLBACK_AGENT = "ctm_sas"
T_AGENT = "tm_phoenix"

# Keep in sync with src/renderer/src/lib/weaponTable.ts SPECS[].model
WEAPON_MODELS = [
    "ak47/weapon_rif_ak47",
    "m4a4/weapon_rif_m4a4",
    "m4a1_silencer/weapon_rif_m4a1_silencer",
    "galilar/weapon_rif_galilar",
    "famas/weapon_rif_famas",
    "aug/weapon_rif_aug",
    "sg556/weapon_rif_sg556",
    "awp/weapon_snip_awp",
    "ssg08/weapon_snip_ssg08",
    "scar20/weapon_snip_scar20",
    "g3sg1/weapon_snip_g3sg1",
    "mac10/weapon_smg_mac10",
    "mp9/weapon_smg_mp9",
    "mp7/weapon_smg_mp7",
    "mp5sd/weapon_smg_mp5sd",
    "ump45/weapon_smg_ump45",
    "p90/weapon_smg_p90",
    "bizon/weapon_smg_bizon",
    "nova/weapon_shot_nova",
    "xm1014/weapon_shot_xm1014",
    "mag7/weapon_shot_mag7",
    "sawedoff/weapon_shot_sawedoff",
    "m249/weapon_mach_m249",
    "negev/weapon_mach_negev",
    "glock18/weapon_pist_glock18",
    "usp_silencer/weapon_pist_usp_silencer",
    "hkp2000/weapon_pist_hkp2000",
    "p250/weapon_pist_p250",
    "fiveseven/weapon_pist_fiveseven",
    "tec9/weapon_pist_tec9",
    "cz75a/weapon_pist_cz75a",
    "deagle/weapon_pist_deagle",
    "revolver/weapon_pist_revolver",
    "elite/weapon_pist_elite",
    "taser/weapon_pist_taser",
    "knife/knife_bayonet/weapon_knife_bayonet",
    "knife/knife_bowie/weapon_knife_bowie",
    "knife/knife_butterfly/weapon_knife_butterfly",
    "knife/knife_canis/weapon_knife_canis",
    "knife/knife_cord/weapon_knife_cord",
    "knife/knife_css/weapon_knife_css",
    "knife/knife_falchion/weapon_knife_falchion",
    "knife/knife_flip/weapon_knife_flip",
    "knife/knife_gut/weapon_knife_gut",
    "knife/knife_karambit/weapon_knife_karambit",
    "knife/knife_kukri/weapon_knife_kukri",
    "knife/knife_m9/weapon_knife_m9",
    "knife/knife_navaja/weapon_knife_navaja",
    "knife/knife_outdoor/weapon_knife_outdoor",
    "knife/knife_push/weapon_knife_push",
    "knife/knife_skeleton/weapon_knife_skeleton",
    "knife/knife_stiletto/weapon_knife_stiletto",
    "knife/knife_tactical/weapon_knife_tactical",
    "knife/knife_talon/weapon_knife_talon",
    "knife/knife_ursus/weapon_knife_ursus",
    "knife/knife_default_t/weapon_knife_default_t",
    "knife/knife_default_ct/weapon_knife_default_ct",
    "grenade/hegrenade/weapon_hegrenade",
    "grenade/flashbang/weapon_flashbang",
    "grenade/smokegrenade/weapon_smokegrenade",
    "grenade/molotov/weapon_molotov",
    "grenade/incendiary/weapon_incendiarygrenade",
    "grenade/decoy/weapon_decoy",
    "c4/weapon_c4",
    "healthshot/weapon_healthshot",
    "shared/shells/ak47/ak47_casing",
    "shared/shells/awp/awp_casing",
    "shared/shells/glock/glock_casing",
    "shared/shells/p90/p90_casing",
    "shared/shells/deagle/deagle_casing",
    "shared/shells/shotgun/nova_casing",
    "shared/shells/shotgun/xm1014_casing",
    "shared/shells/shotgun/mag7_casing",
]


def world_anim(category: str, name: str) -> str:
    return f"animation/anims/world/{category}/_default_{category}/{name}"


def shared_anim(name: str) -> str:
    return f"animation/anims/world/shared/{name}"


def locomotion_anims(category: str) -> list[str]:
    out = [world_anim(category, f"idle_{category}"), world_anim(category, f"idle_crouch_{category}")]
    for direction in DIRECTIONS:
        out.append(world_anim(category, f"run_{direction}_{category}"))
        out.append(world_anim(category, f"walk_{direction}_{category}"))
        out.append(world_anim(category, f"crouch_{direction}_{category}"))
    return out


def warm_spec() -> dict:
    world: list[str] = []
    for category in WORLD:
        world.extend(locomotion_anims(category))
    world.extend(
        [
            shared_anim("breathing"),
            shared_anim("jump_additive_start"),
            shared_anim("jump_additive_land"),
        ]
    )
    world = sorted(set(world))
    return {
        "weapons": list(WEAPON_MODELS),
        "agents": {
            FALLBACK_AGENT: world,
            T_AGENT: world,
        },
    }
