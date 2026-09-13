export type PreviewQuality = "low" | "medium" | "high";
export type PreviewVmPreset = "cs" | "low" | "custom";

export type ViewmodelPrefs = {
  preset: PreviewVmPreset;
  x: number;
  y: number;
  z: number;
  fov: number;
  scale: number;
};

export const DEFAULT_VM_FOV = 54;

const CS_PRESET = { x: 2, y: -100, z: 0.5, fov: DEFAULT_VM_FOV, scale: 1.4 } as const;
/** Less rifle drop, slightly wider FOV so more of the gun sits in frame. */
const LOW_PRESET = { x: 0, y: 4, z: 2, fov: 62, scale: 1.08 } as const;

export const VM_PRESETS: Record<"cs" | "low", Omit<ViewmodelPrefs, "preset">> = {
  cs: CS_PRESET,
  low: LOW_PRESET,
};

export const DEFAULT_VIEWMODEL: ViewmodelPrefs = { preset: "cs", ...CS_PRESET };

export function isPreviewQuality(value: unknown): value is PreviewQuality {
  return value === "low" || value === "medium" || value === "high";
}

export function isPreviewVmPreset(value: unknown): value is PreviewVmPreset {
  return value === "cs" || value === "low" || value === "custom";
}

export function applyVmNamedPreset(preset: "cs" | "low"): ViewmodelPrefs {
  return { preset, ...VM_PRESETS[preset] };
}

export function resetViewmodel(prefs: ViewmodelPrefs): ViewmodelPrefs {
  if (prefs.preset === "low") return applyVmNamedPreset("low");
  return applyVmNamedPreset("cs");
}

export function withVmSlider(prefs: ViewmodelPrefs, patch: Partial<Omit<ViewmodelPrefs, "preset">>): ViewmodelPrefs {
  const next = { ...prefs, ...patch, preset: prefs.preset } as ViewmodelPrefs;
  const named = next.preset === "low" ? VM_PRESETS.low : next.preset === "cs" ? VM_PRESETS.cs : null;
  if (!named || !sameSeat(next, named)) next.preset = "custom";
  return next;
}

function sameSeat(a: Omit<ViewmodelPrefs, "preset">, b: Omit<ViewmodelPrefs, "preset">) {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.fov === b.fov && a.scale === b.scale;
}
