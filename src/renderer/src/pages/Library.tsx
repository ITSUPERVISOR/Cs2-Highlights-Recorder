import { useEffect, useState } from "react";
import { PlayerPicker } from "../components/PlayerPicker";
import type { MatchRow, ReelSettings } from "../lib/types";
import { FileName, SectionHeader, StatusPill, formatDate, formatMap } from "../components/ui";
import { adrTone, clipsTone, kdTone, ratingTone, toneClass } from "../lib/statColors";

export function LibraryPage({ onOpen }: { onOpen: (match: MatchRow) => void }) {
  const [matches, setMatches] = useState<MatchRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<MatchRow | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReelSettings | null>(null);
  const [localIds, setLocalIds] = useState<Set<string>>(new Set());

  async function refresh() {
    setMatches(await window.reel.listMatches());
  }

  useEffect(() => {
    if (!window.reel) {
      setError("Desktop bridge failed to load. Restart with npm run dev.");
      return;
    }
    refresh().catch((err) => setError(String(err)));
    window.reel.getSettings().then(setSettings).catch(() => undefined);
    window.reel
      .detectSteamid()
      .then((payload: { accounts?: { steamid: string }[] }) => {
        setLocalIds(new Set((payload.accounts ?? []).map((account) => account.steamid)));
      })
      .catch(() => undefined);
    return window.reel.onLibraryChanged(() => {
      refresh().catch(() => undefined);
    });
  }, []);

  async function scan() {
    setBusy("Scanning folders…");
    setError(null);
    try {
      setMatches(await window.reel.scanLibrary());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function finishPick(steamid: string, remember: boolean) {
    if (!picker) return;
    setBusy("Saving player…");
    try {
      if (remember) {
        await window.reel.setSettings({ steamId: steamid, askPlayerEveryTime: false });
        setSettings((prev) =>
          prev ? { ...prev, steamId: steamid, askPlayerEveryTime: false } : prev,
        );
      } else {
        await window.reel.setSettings({ askPlayerEveryTime: true });
        setSettings((prev) => (prev ? { ...prev, askPlayerEveryTime: true } : prev));
      }
      const focused = await window.reel.choosePlayer(picker.id, steamid);
      setMatches((prev) => prev.map((row) => (row.id === focused.id ? focused : row)));
      setPicker(null);
      setSelected(null);
      onOpen(focused);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function openOrParse(match: MatchRow) {
    setError(null);
    if (match.payload && match.payload.playerSteamid) {
      onOpen(match);
      return;
    }
    let parsed = match;
    if (!match.payload) {
      setBusy("Parsing demo…");
      try {
        parsed = await window.reel.analyze(match.id);
        setMatches((prev) => prev.map((row) => (row.id === parsed.id ? parsed : row)));
      } catch (err) {
        setError(String(err));
        setBusy(null);
        return;
      } finally {
        setBusy(null);
      }
    }
    const prefs = settings ?? (await window.reel.getSettings());
    const inDemo = parsed.payload?.players.some((player) => player.steamid === prefs.steamId);
    if (!prefs.askPlayerEveryTime && prefs.steamId && inDemo) {
      const focused = await window.reel.choosePlayer(parsed.id, prefs.steamId);
      setMatches((prev) => prev.map((row) => (row.id === focused.id ? focused : row)));
      onOpen(focused);
      return;
    }
    const hint =
      (prefs.steamId && inDemo ? prefs.steamId : null) ??
      parsed.payload?.players.find((player) => localIds.has(player.steamid))?.steamid ??
      null;
    setSelected(hint);
    setPicker(parsed);
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <SectionHeader
        eyebrow="Library"
        title="Your demos"
        action={
          <button
            onClick={scan}
            className="rounded-full bg-amber px-4 py-2 text-sm font-semibold text-ink hover:opacity-90"
          >
            Scan folders
          </button>
        }
      />
      {busy && <p className="text-sm text-amber">{busy}</p>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {matches.length === 0 && (
        <div className="rounded-xl border border-dashed border-line px-8 py-14 text-center text-muted">
          Add a demo folder in Settings, then scan. Valve replays appear after Doctor runs.
        </div>
      )}
      {matches.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line bg-panel/70">
          <div className="grid grid-cols-[minmax(7rem,1.1fr)_minmax(8rem,1.2fr)_minmax(10rem,1.4fr)_4.5rem_6.5rem_6.5rem] gap-3 border-b border-line bg-raised/50 px-4 py-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted">
            <span>Map</span>
            <span>Player</span>
            <span>Performance</span>
            <span className="text-right">Clips</span>
            <span className="text-right">Imported</span>
            <span className="text-right">Status</span>
          </div>
          <div className="divide-y divide-line">
            {matches.map((match) => {
              const you = match.payload?.you;
              const highlights = match.payload?.playerSteamid ? (match.payload.highlightCount ?? 0) : 0;
              const scoreline = match.payload
                ? `${match.payload.scoreline.ct} – ${match.payload.scoreline.t}`
                : null;
              return (
                <button
                  key={match.id}
                  onClick={() => openOrParse(match)}
                  title={match.demoPath}
                  className="grid w-full grid-cols-[minmax(7rem,1.1fr)_minmax(8rem,1.2fr)_minmax(10rem,1.4fr)_4.5rem_6.5rem_6.5rem] items-center gap-3 px-4 py-3.5 text-left transition hover:bg-raised/60"
                >
                  <div className="min-w-0">
                    <div className="font-display truncate text-sm font-semibold capitalize">
                      {formatMap(match.map)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {scoreline ?? (match.payload ? "Pick a player" : "Click to parse")}
                    </div>
                  </div>
                  <div className="min-w-0 truncate text-sm font-medium">
                    {you?.name ?? (match.payload ? "—" : <FileName path={match.demoPath} />)}
                  </div>
                  <div className="min-w-0 text-sm tabular-nums text-muted">
                    {you ? (
                      <span>
                        <span className={toneClass(kdTone(you.kills, you.deaths))}>
                          {you.kills}-{you.deaths}
                        </span>
                        {" · ADR "}
                        <span className={toneClass(adrTone(you.adr))}>{you.adr}</span>
                        {" · "}
                        <span className={toneClass(ratingTone(you.rating))}>{you.rating.toFixed(2)}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </div>
                  <div
                    className={`text-right text-sm font-medium tabular-nums ${
                      you ? toneClass(clipsTone(highlights)) : "text-muted"
                    }`}
                  >
                    {you ? highlights : "—"}
                  </div>
                  <div className="text-right text-xs text-muted">{formatDate(match.importedAt)}</div>
                  <div className="flex justify-end">
                    <StatusPill status={match.status} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {picker && (
        <PlayerPicker
          match={picker}
          localIds={localIds}
          suggested={settings?.steamId ?? ""}
          selected={selected}
          onSelect={setSelected}
          onRemember={() => selected && finishPick(selected, true)}
          onThisDemoOnly={() => selected && finishPick(selected, false)}
          onClose={() => {
            setPicker(null);
            setSelected(null);
          }}
        />
      )}
    </div>
  );
}
