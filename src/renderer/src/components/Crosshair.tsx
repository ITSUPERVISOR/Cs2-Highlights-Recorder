/** Classic four-dash crosshair with a centre gap. */
export function Crosshair() {
  const arm = "absolute bg-[#5ef08a]/85";
  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
      <div className="relative h-6 w-6">
        <div className={`${arm} left-1/2 top-0 h-1.5 w-[2px] -translate-x-1/2`} />
        <div className={`${arm} bottom-0 left-1/2 h-1.5 w-[2px] -translate-x-1/2`} />
        <div className={`${arm} left-0 top-1/2 h-[2px] w-1.5 -translate-y-1/2`} />
        <div className={`${arm} right-0 top-1/2 h-[2px] w-1.5 -translate-y-1/2`} />
      </div>
    </div>
  );
}
