import type { ReactNode } from "react";

export function Badge({ children }: { children: string }) {
  return (
    <span className="inline-flex items-center rounded-md border border-line bg-raised/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber">
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = {
    new: "Unparsed",
    parsed: "Needs player",
    reviewed: "Ready",
    recorded: "Recorded",
  };
  const color =
    status === "recorded"
      ? "text-success border-success/30 bg-success/10"
      : status === "reviewed"
        ? "text-amber border-amber/30 bg-amber/10"
        : status === "parsed"
          ? "text-info border-info/30 bg-info/10"
          : "text-muted border-line bg-raised/40";
  return (
    <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${color}`}>
      {labels[status] ?? status}
    </span>
  );
}

export function FileName({ path }: { path: string }) {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  return <span title={path}>{name}</span>;
}

export function SectionHeader({
  eyebrow,
  title,
  action,
}: {
  eyebrow: string;
  title: string;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-end justify-between gap-4">
      <div>
        <p className="text-[11px] font-medium uppercase tracking-[0.22em] text-muted">{eyebrow}</p>
        <h1 className="font-display mt-1 text-3xl font-semibold tracking-tight">{title}</h1>
      </div>
      {action}
    </header>
  );
}

export function Stat({
  label,
  value,
  hint,
  large,
  toneClass,
}: {
  label: string;
  value: string;
  hint?: string;
  large?: boolean;
  /** Overrides default amber/white value color (e.g. good/mid/bad). */
  toneClass?: string;
}) {
  const valueColor = toneClass ?? (large ? "text-amber" : "");
  return (
    <div className="rounded-xl border border-line bg-panel/80 px-4 py-3">
      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted">{label}</div>
      <div className={`font-display mt-1.5 font-semibold tabular-nums ${large ? "text-3xl" : "text-xl"} ${valueColor}`}>
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function formatDate(ms: number) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatMap(map: string | null | undefined) {
  if (!map) return "Unknown map";
  return map.replace(/^de_/, "").replace(/^cs_/, "");
}
