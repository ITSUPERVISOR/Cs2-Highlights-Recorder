import type { PreviewQuality, ViewmodelPrefs } from "../lib/previewPrefs";
import { applyVmNamedPreset, resetViewmodel, withVmSlider } from "../lib/previewPrefs";

const QUALITIES: PreviewQuality[] = ["low", "medium", "high"];

type Props = {
  quality: PreviewQuality;
  vm: ViewmodelPrefs;
  vmOpen: boolean;
  expanded: boolean;
  onQuality: (quality: PreviewQuality) => void;
  onVm: (vm: ViewmodelPrefs) => void;
  onVmCommit: (vm?: ViewmodelPrefs) => void;
  onToggleVm: () => void;
  onToggleExpand: () => void;
};

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  onCommit: () => void;
}) {
  return (
    <label className="grid grid-cols-[4.5rem_1fr_2.5rem] items-center gap-2 text-[11px] text-muted">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
      />
      <span className="tabular-nums text-right text-fg">{value.toFixed(step < 1 ? 2 : 0)}</span>
    </label>
  );
}

export function PreviewStageHud({
  quality,
  vm,
  vmOpen,
  expanded,
  onQuality,
  onVm,
  onVmCommit,
  onToggleVm,
  onToggleExpand,
}: Props) {
  return (
    <div className="flex flex-col items-end gap-2">
      <div className="pointer-events-auto flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-lg border border-line bg-ink/70 text-[11px]">
          {QUALITIES.map((tier) => (
            <button
              key={tier}
              type="button"
              onClick={() => onQuality(tier)}
              className={`px-2.5 py-1 capitalize ${
                quality === tier ? "bg-amber text-ink" : "text-muted hover:text-fg"
              }`}
            >
              {tier}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onToggleVm}
          title="Viewmodel"
          className={`rounded-lg border px-2.5 py-1 text-xs ${
            vmOpen ? "border-amber bg-amber text-ink" : "border-line bg-ink/70 text-muted hover:text-fg"
          }`}
        >
          VM
        </button>
        <button
          type="button"
          onClick={onToggleExpand}
          title={expanded ? "Collapse (Esc)" : "Expand (F)"}
          className="rounded-lg border border-line bg-ink/70 px-2.5 py-1 text-xs text-muted hover:text-fg"
        >
          {expanded ? "⤡ Collapse" : "⤢ Expand"}
        </button>
      </div>
      {vmOpen && (
        <div className="pointer-events-auto w-72 rounded-xl border border-line bg-ink/90 p-3 shadow-lg backdrop-blur">
          <div className="mb-2 flex gap-1">
            {(["cs", "low"] as const).map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => onVmCommit(applyVmNamedPreset(preset))}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                  vm.preset === preset ? "border-amber bg-amber text-ink" : "border-line text-muted hover:text-fg"
                }`}
              >
                {preset === "cs" ? "CS-like" : "Low"}
              </button>
            ))}
            <span
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                vm.preset === "custom" ? "border-amber text-amber" : "border-line text-muted"
              }`}
            >
              Custom
            </span>
            <button
              type="button"
              onClick={() => onVmCommit(resetViewmodel(vm))}
              className="ml-auto text-[11px] text-muted hover:text-fg"
            >
              Reset
            </button>
          </div>
          <div className="grid gap-1.5">
            <Slider
              label="Offset X"
              value={vm.x}
              min={-12}
              max={12}
              step={0.5}
              onChange={(x) => onVm(withVmSlider(vm, { x }))}
              onCommit={() => onVmCommit()}
            />
            <Slider
              label="Offset Y"
              value={vm.y}
              min={-120}
              max={20}
              step={0.5}
              onChange={(y) => onVm(withVmSlider(vm, { y }))}
              onCommit={() => onVmCommit()}
            />
            <Slider
              label="Offset Z"
              value={vm.z}
              min={-12}
              max={12}
              step={0.5}
              onChange={(z) => onVm(withVmSlider(vm, { z }))}
              onCommit={() => onVmCommit()}
            />
            <Slider
              label="VM FOV"
              value={vm.fov}
              min={40}
              max={75}
              step={1}
              onChange={(fov) => onVm(withVmSlider(vm, { fov }))}
              onCommit={() => onVmCommit()}
            />
            <Slider
              label="Scale"
              value={vm.scale}
              min={0.7}
              max={1.4}
              step={0.02}
              onChange={(scale) => onVm(withVmSlider(vm, { scale }))}
              onCommit={() => onVmCommit()}
            />
          </div>
        </div>
      )}
    </div>
  );
}
