import { useEffect, useState } from "react";
import { KillFeed } from "../components/KillFeed";
import { PlayerPicker } from "../components/PlayerPicker";
import type { MatchRow, Moment, PlayerStats, ReelSettings } from "../lib/types";
import { Badge, Metric, Stat, formatMap } from "../components/ui";
import { adrTone, kdTone, ratingTone, toneClass } from "../lib/statColors";

export function MatchPage({
  match,
  onBack,
  onQueued,
  onMatchChange,
}: {
  match: MatchRow;
  onBack: () => void;
  onQueued: () => void;
  onMatchChange: (match: MatchRow) => void;
}) {
  const payload = match.payload;
  const [busy, setBusy] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [watchHint, setWatchHint] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<string | null>(payload?.playerSteamid ?? null);
  const [localIds, setLocalIds] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState<ReelSettings | null>(null);

  useEffect(() => {
    window.reel.getSettings().then(setSettings).catch(() => undefined);
    window.reel
      .detectSteamid()
      .then((report: { accounts?: { steamid: string }[] }) => {
        setLocalIds(new Set((report.accounts ?? []).map((account) => account.steamid)));
      })
      .catch(() => undefined);
  }, []);

  if (!payload) {
    return (
      <div className="p-8">
        <button onClick={onBack} className="text-sm text-muted hover:text-fg">
          ← Library
        </button>
        <p className="mt-6 text-muted">This demo has not been parsed yet.</p>
      </div>
    );
  }

  const youId = payload.playerSteamid;
  const you = payload.you;
  const rounds = payload.rounds
    .map((round) => ({
      ...round,
      moments: youId ? round.moments.filter((moment) => moment.steamid === youId) : round.moments,
    }))
    .filter((round) => round.moments.length > 0);

  const ctPlayers = payload.players.filter((p) => p.side === "CT");
  const tPlayers = payload.players.filter((p) => p.side === "T");
  const otherPlayers = payload.players.filter((p) => p.side !== "CT" && p.side !== "T");

  function jumpToRound(number: number) {
    document.getElementById(`round-${number}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function watchMoment(moment: Moment) {
    setBusy("Launching CS2…");
    try {
      const result = await window.reel.watch(match.demoPath, moment.firstTick, moment.steamid);
      setCopied(result.copyText);
      setWatchHint(result.hint ?? null);
    } catch (err) {
      setCopied(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function queueMoment(moment: Moment) {
    await window.reel.addToQueue(match.id, moment);
    onQueued();
  }

  async function applyPick(steamid: string, remember: boolean) {
    if (remember) {
      await window.reel.setSettings({ steamId: steamid, askPlayerEveryTime: false });
    } else {
      await window.reel.setSettings({ askPlayerEveryTime: true });
    }
    const focused = await window.reel.choosePlayer(match.id, steamid);
    onMatchChange(focused);
    setPicking(false);
  }

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-line bg-panel/40 px-8 py-5 backdrop-blur">
        <button onClick={onBack} className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted hover:text-fg">
          ← Library
        </button>
        <div className="mt-3 flex flex-wrap items-start justify-between gap-6">
          <div>
            <h1 className="font-display text-3xl font-semibold capitalize tracking-tight">
              {formatMap(payload.map)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              <span className="tabular-nums text-fg">
                {payload.scoreline.ct} – {payload.scoreline.t}
              </span>
              {you ? ` · ${you.name}` : ""}
            </p>
          </div>
          <div className="text-right">
            <div className="text-sm text-muted">{payload.highlightCount} clips</div>
            <button
              type="button"
              onClick={() => {
                setSelected(payload.playerSteamid);
                setPicking(true);
              }}
              className="mt-1 text-sm font-medium text-amber hover:underline"
            >
              Change player
            </button>
          </div>
        </div>

        {you && (
          <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label="Rating" value={you.rating.toFixed(2)} large toneClass={toneClass(ratingTone(you.rating))} />
            <Stat
              label="K / D"
              value={`${you.kills} / ${you.deaths}`}
              toneClass={toneClass(kdTone(you.kills, you.deaths))}
            />
            <Stat label="ADR" value={String(you.adr)} toneClass={toneClass(adrTone(you.adr))} />
            <Stat label="KAST" value={`${you.kast.toFixed(0)}%`} />
            <Stat label="HS%" value={`${you.hsPercent.toFixed(0)}%`} />
            <Stat label="Assists" value={String(you.assists)} />
          </div>
        )}

        {rounds.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-1.5">
            {rounds.map((round) => (
              <button
                key={round.index}
                type="button"
                onClick={() => jumpToRound(round.number)}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-muted transition hover:border-amber hover:text-fg"
              >
                R{round.number}
              </button>
            ))}
          </div>
        )}
      </header>

      {busy && <div className="px-8 pt-4 text-sm text-amber">{busy}</div>}
      {copied && (
        <div className="px-8 pt-3 text-xs text-muted">
          Copied: <code className="text-amber">{copied}</code>
          {watchHint && <p className="mt-1">{watchHint}</p>}
        </div>
      )}

      <div className="flex-1 space-y-8 overflow-auto p-8">
        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Scoreboard</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <ScoreboardSide title="CT" score={payload.scoreline.ct} players={ctPlayers} youId={youId} />
            <ScoreboardSide title="T" score={payload.scoreline.t} players={tPlayers} youId={youId} />
          </div>
          {otherPlayers.length > 0 && (
            <div className="mt-3">
              <ScoreboardSide title="Other" score={null} players={otherPlayers} youId={youId} />
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted">Clips to record</h2>
          {rounds.length === 0 && (
            <p className="text-sm text-muted">No clips for this player. Try Change player, or parse another demo.</p>
          )}
          <div className="grid gap-6">
            {rounds.map((round) => (
              <div key={round.index} id={`round-${round.number}`} className="scroll-mt-4">
                <div className="mb-2 flex items-baseline gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">
                  <span>R{round.number}</span>
                  <span className="font-normal normal-case tracking-normal">
                    {round.ctScore}-{round.tScore} · {round.winner || "?"}
                  </span>
                </div>
                <div className="grid gap-2">
                  {round.moments.map((moment) => (
                    <ClipRow
                      key={moment.id}
                      moment={moment}
                      onWatch={() => watchMoment(moment)}
                      onQueue={() => queueMoment(moment)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {picking && (
        <PlayerPicker
          match={match}
          localIds={localIds}
          suggested={settings?.steamId ?? payload.playerSteamid ?? ""}
          selected={selected}
          onSelect={setSelected}
          onRemember={() => selected && applyPick(selected, true)}
          onThisDemoOnly={() => selected && applyPick(selected, false)}
          onClose={() => setPicking(false)}
          title="Change player"
        />
      )}
    </div>
  );
}

function ScoreboardSide({
  title,
  score,
  players,
  youId,
}: {
  title: string;
  score: number | null;
  players: PlayerStats[];
  youId: string | null;
}) {
  const sorted = [...players].sort((a, b) => b.rating - a.rating);
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-panel/70">
      <div className="flex items-center justify-between border-b border-line bg-raised/40 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">{title}</span>
        {score != null && <span className="font-display text-lg font-semibold tabular-nums">{score}</span>}
      </div>
      <div className="grid grid-cols-[1fr_4rem_3.5rem_3.5rem] gap-2 border-b border-line px-3 py-1.5 text-[9px] font-semibold uppercase tracking-wide text-muted">
        <span>Player</span>
        <span className="text-right">K/D/A</span>
        <span className="text-right">ADR</span>
        <span className="text-right">Rat</span>
      </div>
      {sorted.length === 0 && <p className="px-3 py-3 text-xs text-muted">No players</p>}
      {sorted.map((player) => {
        const isYou = player.steamid === youId;
        return (
          <div
            key={player.steamid}
            className={`grid grid-cols-[1fr_4rem_3.5rem_3.5rem] items-center gap-2 px-3 py-2 text-sm ${
              isYou ? "bg-amber/10" : ""
            }`}
          >
            <span className={`truncate ${isYou ? "font-semibold text-amber" : ""}`}>
              {player.name || player.steamid}
              {isYou && <span className="ml-1.5 text-[9px] uppercase tracking-wide text-amber">You</span>}
            </span>
            <span className={`text-right tabular-nums ${toneClass(kdTone(player.kills, player.deaths))}`}>
              {player.kills}/{player.deaths}/{player.assists}
            </span>
            <span className={`text-right tabular-nums ${toneClass(adrTone(player.adr))}`}>{player.adr}</span>
            <span className={`text-right font-medium tabular-nums ${toneClass(ratingTone(player.rating))}`}>
              {player.rating.toFixed(2)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ClipRow({
  moment,
  onWatch,
  onQueue,
}: {
  moment: Moment;
  onWatch: () => void;
  onQueue: () => void;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-xl border border-line bg-panel/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Metric label="Clip score" value={moment.score.toFixed(1)} />
          <span className="text-xs text-muted">{moment.durationSeconds.toFixed(1)}s</span>
          {moment.labels.map((label) => (
            <Badge key={label}>{label}</Badge>
          ))}
        </div>
        {moment.clutch && (
          <p className="mt-2 text-xs text-muted">
            Clutch 1v{moment.clutch.opponents} · {moment.clutch.won ? "won" : "lost"} · {moment.clutch.kills} kills
          </p>
        )}
        <div className="mt-2">
          <KillFeed kills={moment.kills} />
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <button
          onClick={onWatch}
          className="rounded-full border border-line px-3.5 py-1.5 text-sm font-medium hover:border-amber"
        >
          Watch
        </button>
        <button
          onClick={onQueue}
          className="rounded-full bg-amber px-3.5 py-1.5 text-sm font-semibold text-ink"
        >
          Queue
        </button>
      </div>
    </article>
  );
}
