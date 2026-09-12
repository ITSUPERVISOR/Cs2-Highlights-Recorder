import { useEffect, useState } from "react";
import type { MatchRow, PlayerStats } from "../lib/types";
import { SectionHeader, Stat, formatMap } from "../components/ui";
import { adrTone, barToneClass, clipsTone, ratingTone, toneClass } from "../lib/statColors";

function avg(values: number[]) {
  if (!values.length) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(rows: PlayerStats[], key: keyof PlayerStats) {
  return rows.reduce((n, row) => n + Number(row[key] ?? 0), 0);
}

export function StatsPage() {
  const [matches, setMatches] = useState<MatchRow[]>([]);

  useEffect(() => {
    window.reel.listMatches().then(setMatches);
  }, []);

  const reviewed = matches.filter((m) => m.payload?.you);
  const yours = reviewed.map((m) => m.payload!.you!) as PlayerStats[];
  const highlights = matches.reduce((n, m) => n + (m.payload?.highlightCount ?? 0), 0);
  const recorded = matches.reduce((n, m) => n + m.recordedCount, 0);

  const avgRating = avg(yours.map((p) => p.rating));
  const avgAdr = avg(yours.map((p) => p.adr));

  return (
    <div className="flex h-full flex-col gap-8 overflow-auto p-8">
      <SectionHeader eyebrow="Career" title="Stats" />
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Matches parsed" value={String(yours.length)} />
        <Stat
          label="Avg rating"
          value={avgRating.toFixed(2)}
          toneClass={yours.length ? toneClass(ratingTone(avgRating)) : undefined}
        />
        <Stat
          label="Avg ADR"
          value={avgAdr.toFixed(1)}
          toneClass={yours.length ? toneClass(adrTone(avgAdr)) : undefined}
        />
        <Stat label="Avg KAST" value={`${avg(yours.map((p) => p.kast)).toFixed(1)}%`} />
        <Stat
          label="3K / 4K / ACE"
          value={`${sum(yours, "multi3k")} / ${sum(yours, "multi4k")} / ${sum(yours, "aces")}`}
        />
        <Stat label="Clutches" value={`${sum(yours, "clutchWins")} / ${sum(yours, "clutchAttempts")}`} />
        <Stat
          label="Highlights found"
          value={String(highlights)}
          toneClass={toneClass(clipsTone(highlights))}
        />
        <Stat label="Clips banked" value={String(recorded)} />
      </div>
      <section>
        <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Recent rating</h2>
        <div className="rounded-xl border border-line bg-panel/70 p-4">
          {reviewed.length === 0 && (
            <span className="text-sm text-muted">Parse a few demos to see a sparkline.</span>
          )}
          {reviewed.length > 0 && (
            <div className="flex h-36 items-end gap-2">
              {reviewed
                .slice()
                .reverse()
                .map((match) => {
                  const player = match.payload!.you!;
                  const tone = ratingTone(player.rating);
                  return (
                    <div key={match.id} className="flex min-w-0 flex-1 flex-col items-center gap-2">
                      <div
                        className={`w-full max-w-[2.5rem] rounded-t ${barToneClass(tone)}`}
                        style={{ height: `${Math.max(10, Math.min(100, (player.rating / 2) * 100))}%` }}
                        title={`${formatMap(match.map)} · ${player.rating.toFixed(2)}`}
                      />
                      <span className="w-full truncate text-center text-[10px] capitalize text-muted">
                        {formatMap(match.map)}
                      </span>
                      <span className={`text-[10px] tabular-nums ${toneClass(tone)}`}>
                        {player.rating.toFixed(2)}
                      </span>
                    </div>
                  );
                })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
