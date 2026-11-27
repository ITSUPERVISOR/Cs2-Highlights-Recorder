import type { PreviewPose } from "../lib/clipPlayback";
import { weaponDisplayName } from "../lib/weaponTable";

/** Turn "SecondMid" into "Second Mid". */
function placeLabel(place: string) {
  if (!place) return "";
  return place.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Bottom-left readout: health, armour, callout and weapon.
 *
 * A DOM overlay rather than 3D, so it stays crisp and costs nothing to draw.
 */
export function PovHud({ pose, team }: { pose: PreviewPose; team: string }) {
  const accent = team === "CT" ? "text-[#5eb1ef]" : "text-[#f0a12a]";
  const low = pose.health <= 30;
  return (
    <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex flex-col gap-1">
      {pose.place && (
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-white/55">
          {placeLabel(pose.place)}
        </span>
      )}
      <div className="flex items-end gap-4">
        <span
          className={`font-display text-3xl font-semibold tabular-nums drop-shadow ${
            low ? "text-danger" : accent
          }`}
        >
          {Math.max(0, Math.round(pose.health))}
        </span>
        {pose.armor > 0 && (
          <span className="text-sm tabular-nums text-white/70 drop-shadow">
            {Math.round(pose.armor)} <span className="text-white/40">armor</span>
          </span>
        )}
      </div>
      {pose.weapon && (
        <span className="text-xs uppercase tracking-[0.1em] text-white/60">
          {weaponDisplayName(pose.weapon)}
        </span>
      )}
    </div>
  );
}
