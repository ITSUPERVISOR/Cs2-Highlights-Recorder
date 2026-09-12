import type { MatchRow, PlayerStats } from "../lib/types";
import { adrTone, clipsTone, kdTone, ratingTone, toneClass } from "../lib/statColors";

export function PlayerPicker({
  match,
  localIds,
  suggested,
  selected,
  onSelect,
  onRemember,
  onThisDemoOnly,
  onClose,
  title,
}: {
  match: MatchRow;
  localIds: Set<string>;
  suggested: string;
  selected: string | null;
  onSelect: (steamid: string) => void;
  onRemember: () => void;
  onThisDemoOnly: () => void;
  onClose?: () => void;
  title?: string;
}) {
  const players = [...(match.payload?.players ?? [])].sort((a, b) => {
    const rank = (player: PlayerStats) =>
      (player.steamid === suggested ? 2 : 0) + (localIds.has(player.steamid) ? 1 : 0);
    const diff = rank(b) - rank(a);
    if (diff) return diff;
    return b.rating - a.rating;
  });
  const chosen = players.find((player) => player.steamid === selected);
  const highlightCount = (steamid: string) =>
    (match.payload?.moments ?? []).filter((moment) => moment.steamid === steamid).length;

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink/80 p-6">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-3xl border border-line bg-panel shadow-2xl">
        <header className="border-b border-line px-6 py-5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">This demo</p>
          <h2 className="mt-1 text-2xl font-semibold">{title ?? "Who should we score?"}</h2>
          <p className="mt-1 text-sm text-muted">
            {match.map ?? "Unknown map"} · pick the player whose rounds you want to record.
          </p>
        </header>
        <div className="flex-1 overflow-auto px-3 py-3">
          {players.map((player) => {
            const active = selected === player.steamid;
            return (
              <button
                key={player.steamid}
                type="button"
                onClick={() => onSelect(player.steamid)}
                className={`mb-1 flex w-full items-center gap-4 rounded-2xl px-4 py-3 text-left ${
                  active ? "bg-amber text-ink" : "hover:bg-raised"
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{player.name || player.steamid}</span>
                    {localIds.has(player.steamid) && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                          active ? "bg-ink/10" : "bg-raised text-amber"
                        }`}
                      >
                        This PC
                      </span>
                    )}
                    {player.steamid === suggested && suggested && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                          active ? "bg-ink/10" : "text-muted"
                        }`}
                      >
                        Last used
                      </span>
                    )}
                  </div>
                  <div className={`mt-1 text-xs ${active ? "text-ink/70" : "text-muted"}`}>
                    {player.side || "?"} ·{" "}
                    <span className={active ? undefined : toneClass(kdTone(player.kills, player.deaths))}>
                      {player.kills}-{player.deaths}
                    </span>
                    {" · ADR "}
                    <span className={active ? undefined : toneClass(adrTone(player.adr))}>{player.adr}</span>
                    {" · "}
                    <span className={active ? undefined : toneClass(ratingTone(player.rating))}>
                      {player.rating.toFixed(2)}
                    </span>{" "}
                    rating
                  </div>
                </div>
                <div
                  className={`text-right text-sm ${
                    active ? "" : toneClass(clipsTone(highlightCount(player.steamid)))
                  }`}
                >
                  {highlightCount(player.steamid)} clips
                </div>
              </button>
            );
          })}
        </div>
        <footer className="flex flex-col gap-2 border-t border-line px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
          {onClose ? (
            <button type="button" onClick={onClose} className="text-sm text-muted hover:text-white">
              Cancel
            </button>
          ) : (
            <span className="text-xs text-muted">
              {chosen ? `Scoring ${chosen.name}` : "Select a player to continue"}
            </span>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <button
              type="button"
              disabled={!selected}
              onClick={onThisDemoOnly}
              className="rounded-full border border-line px-4 py-2 text-sm disabled:opacity-40"
            >
              Just this demo
            </button>
            <button
              type="button"
              disabled={!selected}
              onClick={onRemember}
              className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40"
            >
              Remember as my account
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
