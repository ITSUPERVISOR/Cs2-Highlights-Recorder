/**
 * Sniper scope: a circular cutout with hairlines.
 *
 * The black surround is one huge spread shadow on a round element, which keeps
 * the cutout perfectly circular at any viewport shape without a mask image.
 */
export function ScopeOverlay() {
  const hair = "absolute bg-black/80";
  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div className="absolute left-1/2 top-1/2 aspect-square h-[94%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/60 shadow-[0_0_0_9999px_rgba(0,0,0,0.97)]" />
      {/* Hairlines stop short of the middle so the target stays clear. */}
      <div className={`${hair} left-0 top-1/2 h-[1.5px] w-[calc(50%-14px)] -translate-y-1/2`} />
      <div className={`${hair} right-0 top-1/2 h-[1.5px] w-[calc(50%-14px)] -translate-y-1/2`} />
      <div className={`${hair} left-1/2 top-0 h-[calc(50%-14px)] w-[1.5px] -translate-x-1/2`} />
      <div className={`${hair} bottom-0 left-1/2 h-[calc(50%-14px)] w-[1.5px] -translate-x-1/2`} />
      <div className="absolute left-1/2 top-1/2 h-[3px] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/85" />
    </div>
  );
}
