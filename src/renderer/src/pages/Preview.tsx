import { useCallback, useEffect, useMemo, useState } from "react";
import { ClipStage, type ArmsStatus, type MapStatus } from "../components/ClipStage";
import { KillFeed } from "../components/KillFeed";
import { Badge, Metric, SectionHeader, Stat, formatMap } from "../components/ui";
import type { MatchRow, QueueItem } from "../lib/types";
import type { PreviewDump } from "../lib/clipPlayback";
import { buildAssetSpec, buildPriorityAssetSpec } from "../lib/assetSpec";
import { invalidateGltfCache } from "../lib/loadGltf";
import { mergeAssetBundles, type AssetBundle } from "../lib/gameAssets";
import { adrTone, ratingTone, toneClass } from "../lib/statColors";

type Phase = "idle" | "poses" | "ready";

const PHASE_LABEL: Record<Phase, string> = {
  idle: "",
  poses: "Reading clip poses from the demo…",
  ready: "",
};

/** Describe the geometry on screen, not the exporter that ran. */
function describeGeometry(mapSource: string, status: MapStatus | null, mapInstalled?: boolean) {
  if (mapSource === "missing" || mapInstalled === false) return "flat ground (map not in CS2 install)";
  if (mapSource !== "collision") return "flat ground (no collision hull)";
  switch (status) {
    case "ready":
      return "collision mesh";
    case "failed":
      return "flat ground (mesh failed to load)";
    case "mismatch":
      return "flat ground (mesh did not line up)";
    default:
      return "loading collision mesh…";
  }
}

function describeHands(assets: AssetBundle | null, assetsReady: boolean, armsStatus: ArmsStatus | null) {
  if (!assetsReady) return "loading player models…";
  if (armsStatus === "real") return "real models";
  if (armsStatus === "failed" || assets) return "procedural hands";
  return "";
}

function describeGaps(assets: AssetBundle | null) {
  if (!assets) return "";
  const missing = assets.weaponsMissing ?? [];
  const unmatched = Object.values(assets.unmatchedAnims ?? {}).flat();
  const painted = Object.keys(assets.skins ?? {}).length;
  if (!missing.length && !unmatched.length && !painted) return "";
  const bits: string[] = [];
  if (missing.length) bits.push(`${missing.length} weapon${missing.length === 1 ? "" : "s"} missing`);
  if (unmatched.length) bits.push("some poses unmatched");
  if (painted) bits.push(`${painted} skin${painted === 1 ? "" : "s"}`);
  return bits.join(" · ");
}

export function PreviewPage({ onOpenQueue }: { onOpenQueue: () => void }) {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [dump, setDump] = useState<PreviewDump | null>(null);
  const [assets, setAssets] = useState<AssetBundle | null>(null);
  const [assetsReady, setAssetsReady] = useState(false);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [mapStatus, setMapStatus] = useState<MapStatus | null>(null);
  const [mapChip, setMapChip] = useState<string | null>(null);
  const [mapExporting, setMapExporting] = useState(false);
  const [autoStarted, setAutoStarted] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [armsStatus, setArmsStatus] = useState<ArmsStatus | null>(null);

  const handleMapStatus = useCallback((status: MapStatus) => {
    setMapStatus(status);
    setMapChip(status === "loading" ? "Loading map geometry…" : null);
  }, []);

  const handleArmsStatus = useCallback((status: ArmsStatus) => {
    setArmsStatus(status);
  }, []);

  async function refresh() {
    const next = (await window.reel.listQueue()) as QueueItem[];
    setItems(next);
    setSelectedId((cur) => {
      if (cur && next.some((item) => item.id === cur)) return cur;
      return next[0]?.id ?? null;
    });
  }

  useEffect(() => {
    refresh();
  }, []);

  const selected = items.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    if (!selected) {
      setMatch(null);
      setDump(null);
      setAssets(null);
      setAssetsReady(false);
      setAssetsLoading(false);
      setPlaying(false);
      setPhase("idle");
      setMapChip(null);
      setMapExporting(false);
      setArmsStatus(null);
      return;
    }
    let cancelled = false;
    setError(null);
    setPhase("poses");
    setDump(null);
    setAssets(null);
    setAssetsReady(false);
    setAssetsLoading(false);
    setPlaying(false);
    setMapStatus(null);
    setMapChip(null);
    setMapExporting(false);
    setAutoStarted(false);
    setArmsStatus(null);
    (async () => {
      try {
        const row = await window.reel.getMatch(selected.matchId);
        if (cancelled) return;
        if (!row) throw new Error("That match is no longer in the library.");
        setMatch(row);
        const tickrate = row.payload?.tickrate || 64;
        const start = Math.max(96, Math.floor(selected.moment.firstTick - 4 * tickrate));
        const end = Math.floor(selected.moment.lastTick + 3 * tickrate);
        const mapName = row.payload?.map ?? row.map ?? "";

        // Start the map export while the demo is still being parsed.
        const mapTask = mapName
          ? window.reel.previewMap(mapName).catch(() => null)
          : Promise.resolve(null);
        if (mapName) {
          setMapExporting(true);
          setMapChip(`Exporting ${formatMap(mapName)}…`);
        }

        const payload = (await window.reel.previewClip(
          row.demoPath,
          start,
          end,
          selected.moment.steamid,
          mapName,
          tickrate,
        )) as PreviewDump;
        if (cancelled) return;
        setDump(payload);
        setTick(payload.startTick);
        setPlaying(false);

        const cachedCollision = Boolean(payload.mapGltf && payload.mapSource === "collision");
        if (cachedCollision) {
          setMapExporting(false);
          setMapChip("Loading map geometry…");
        } else if (!mapName) {
          setMapExporting(false);
          setMapChip(null);
        }

        const applyMap = (map: { mapGltf?: string | null; mapSource?: string } | null) => {
          if (cancelled) return;
          setMapExporting(false);
          if (!map) {
            if (!cachedCollision) setMapChip(null);
            return;
          }
          const mapSource = String(map.mapSource || payload.mapSource);
          const mapGltf = (map.mapGltf as string | null) ?? payload.mapGltf;
          setDump((cur) => (cur ? { ...cur, mapGltf, mapSource } : cur));
          if (mapSource !== "collision") setMapChip(null);
        };

        // Cache-hot dumps already have the collision path; do not wait on IPC.
        void mapTask.then(applyMap);

        setAssetsLoading(true);
        const priority = buildPriorityAssetSpec(payload);
        const full = buildAssetSpec(payload);
        const hasPriority = priority.weapons.length > 0 || Object.keys(priority.agents).length > 0;

        const applyBundle = (bundle: unknown, wave: "priority" | "full") => {
          if (cancelled) return;
          const next = (bundle as AssetBundle)?.ok ? (bundle as AssetBundle) : null;
          if (!next) {
            if (wave === "full") setAssetsReady(true);
            return;
          }
          setAssets((prev) => {
            if (wave === "full" && prev) {
              for (const [agent, path] of Object.entries(next.agents ?? {})) {
                if (prev.agents[agent] === path) invalidateGltfCache(path);
              }
            }
            const merged = mergeAssetBundles(prev, next);
            if (wave === "full") {
              return {
                ...merged,
                weaponsMissing: next.weaponsMissing ?? [],
                unmatchedAnims: next.unmatchedAnims ?? {},
              };
            }
            return merged;
          });
          if (wave === "full") setAssetsReady(true);
        };

        try {
          if (hasPriority) {
            try {
              const first = await window.reel.previewAssets(priority);
              applyBundle(first, "priority");
            } catch {
              // Full export still has a chance; do not give up on the first wave.
            }
          }
          if (cancelled) return;
          const rest = await window.reel.previewAssets(full);
          applyBundle(rest, "full");
        } catch {
          if (!cancelled) {
            setAssets((prev) => prev);
            setAssetsReady(true);
          }
        } finally {
          if (!cancelled) setAssetsLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(String(err));
          setPhase("ready");
          setMapChip(null);
          setMapExporting(false);
          setAssetsReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  useEffect(() => {
    if (!dump) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Escape") setExpanded(false);
      else if (event.key === "f" || event.key === "F") setExpanded((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dump]);

  const mapReady = Boolean(
    dump &&
      !mapExporting &&
      (dump.mapSource !== "collision" ||
        mapStatus === "ready" ||
        mapStatus === "failed" ||
        mapStatus === "mismatch"),
  );
  const hasArmAssets = Boolean(assets && Object.keys(assets.agents ?? {}).length);
  const modelsReady = assetsReady && (!hasArmAssets || armsStatus === "real" || armsStatus === "failed");
  const prepared = Boolean(dump) && mapReady && modelsReady;

  useEffect(() => {
    if (!prepared || !dump || autoStarted) return;
    setTick(dump.startTick);
    setPlaying(true);
    setAutoStarted(true);
  }, [prepared, dump, autoStarted]);

  useEffect(() => {
    if (!playing || !dump) return;
    let raf = 0;
    let last = performance.now();
    const msPerTick = 1000 / Math.max(dump.tickrate, 1);
    const step = () => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      setTick((cur) => {
        const next = cur + dt / msPerTick;
        if (next >= dump.endTick) {
          setPlaying(false);
          return dump.endTick;
        }
        return next;
      });
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, dump]);

  const overlayKills = useMemo(() => {
    if (!selected || !dump) return [];
    const windowTicks = dump.tickrate * 5;
    return selected.moment.kills.filter((kill) => kill.tick <= tick && tick - kill.tick <= windowTicks);
  }, [selected, dump, tick]);

  const you = match?.payload?.you;
  const gaps = describeGaps(assets);
  const hands = describeHands(assets, assetsReady, armsStatus);

  return (
    // Below xl the three columns stack, and a height-capped page would compress
    // the rows below their content and clip them. Scroll instead of overlapping.
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-6 xl:overflow-hidden">
      <SectionHeader
        eyebrow="No CS2"
        title="Preview"
        action={
          <button
            type="button"
            onClick={onOpenQueue}
            className="rounded-full border border-line px-4 py-2 text-sm font-medium"
          >
            Open Queue to record
          </button>
        }
      />
      <p className="max-w-2xl text-sm text-muted">
        Watch a waiting clip in-app. This is a pose replay, not HLAE. Record still lives on Queue.
      </p>
      <div className="grid min-h-0 grid-cols-1 gap-4 xl:flex-1 xl:grid-cols-[16rem_minmax(0,1fr)_18rem]">
        <aside className="max-h-56 overflow-auto rounded-xl border border-line bg-panel/70 p-3 xl:max-h-none xl:min-h-0">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">Waiting queue</p>
          {items.length === 0 && (
            <p className="text-sm text-muted">Queue clips from a match review first.</p>
          )}
          <div className="grid gap-1.5">
            {items.map((item) => {
              const active = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`rounded-lg border px-3 py-2 text-left ${
                    active ? "border-amber bg-raised" : "border-line hover:border-amber/40"
                  }`}
                >
                  <div className="truncate text-sm font-medium">{item.moment.name}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    R{item.moment.round} · {item.moment.score.toFixed(1)}
                  </div>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-col gap-3">
          {/*
            Expanding is a class swap, never a remount or a portal: tearing
            ClipStage down would drop the WebGL context and re-parse the map.
          */}
          <div
            className={
              expanded
                ? "fixed inset-0 z-40 overflow-hidden border-0 bg-ink"
                : // A fixed viewport height when stacked, so it neither collapses
                  // nor forces the page taller than it needs to be.
                  "relative h-[52vh] min-h-[280px] overflow-hidden rounded-xl border border-line xl:h-auto xl:min-h-0 xl:flex-1"
            }
          >
            {dump ? (
              <ClipStage
                dump={dump}
                tick={tick}
                kills={selected?.moment.kills ?? []}
                assets={assets}
                assetsReady={assetsReady}
                onMapStatus={handleMapStatus}
                onArmsStatus={handleArmsStatus}
              />
            ) : null}
            {!dump && (
              <div className="flex h-full min-h-[280px] items-center justify-center px-6 text-center text-sm text-muted">
                {PHASE_LABEL[phase] || error || "Select a queued clip."}
              </div>
            )}
            {dump && !prepared && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-ink/85 px-6 text-center">
                <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-amber" />
                <p className="text-sm text-muted">
                  {!mapReady
                    ? mapChip || "Loading the map…"
                    : "Loading player models…"}
                </p>
                <p className="max-w-xs text-[11px] text-muted">
                  Playback waits until the map and models are in, so the clip does not run while they are still arriving.
                </p>
              </div>
            )}
            {dump && overlayKills.length > 0 && (
              <div className="pointer-events-none absolute left-3 top-3 z-10 max-w-[55%]">
                <KillFeed kills={overlayKills.slice(-6)} />
              </div>
            )}
            {dump && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                title={expanded ? "Collapse (Esc)" : "Expand (F)"}
                className="absolute right-3 top-3 z-30 rounded-lg border border-line bg-ink/70 px-2.5 py-1 text-xs text-muted hover:text-fg"
              >
                {expanded ? "⤡ Collapse" : "⤢ Expand"}
              </button>
            )}
          </div>
          {dump && (
            <div
              className={
                expanded
                  ? "fixed bottom-6 left-1/2 z-50 flex w-[min(56rem,90vw)] -translate-x-1/2 items-center gap-3 rounded-xl border border-line bg-panel/90 px-4 py-3 backdrop-blur"
                  : "flex items-center gap-3"
              }
            >
              <button
                type="button"
                onClick={() => {
                  if (!prepared) return;
                  setPlaying((p) => !p);
                }}
                disabled={!prepared}
                className="rounded-full bg-amber px-4 py-1.5 text-sm font-semibold text-ink disabled:opacity-40"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <input
                type="range"
                min={dump.startTick}
                max={dump.endTick}
                value={Math.round(tick)}
                onChange={(event) => {
                  setPlaying(false);
                  setTick(Number(event.target.value));
                }}
                disabled={!prepared}
                className="min-w-0 flex-1"
              />
              <span className="w-16 text-right text-xs tabular-nums text-muted">
                {((tick - dump.startTick) / dump.tickrate).toFixed(1)}s
              </span>
            </div>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {dump && (
            <p className="text-[11px] text-muted">
              {formatMap(dump.map)} · {dump.frames.length} poses ·{" "}
              {describeGeometry(dump.mapSource, mapStatus, dump.mapInstalled)}
              {hands ? ` · ${hands}` : ""}
              {gaps ? ` · ${gaps}` : ""}
            </p>
          )}
        </section>

        <aside className="overflow-auto xl:min-h-0">
          {!selected && <p className="text-sm text-muted">Clip stats appear here.</p>}
          {selected && (
            <div className="grid gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">This clip</p>
                <h2 className="mt-1 font-display text-xl font-semibold">{selected.moment.name}</h2>
                <p className="text-sm text-muted">
                  {formatMap(match?.payload?.map ?? match?.map)} · R{selected.moment.round}
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {(selected.moment.labels ?? []).map((label) => (
                  <Badge key={label}>{label}</Badge>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Clip score" value={selected.moment.score.toFixed(1)} />
                <Stat label="Duration" value={`${selected.moment.durationSeconds.toFixed(1)}s`} />
              </div>
              {selected.moment.clutch && (
                <p className="text-sm text-muted">
                  Clutch 1v{selected.moment.clutch.opponents} · {selected.moment.clutch.won ? "won" : "lost"}
                </p>
              )}
              <KillFeed kills={selected.moment.kills} />
              {you && (
                <div className="grid gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">This match</p>
                  <div className="rounded-xl border border-line bg-panel/80 px-4 py-3">
                    <Metric
                      label="Scoreline"
                      value={`${match?.payload?.scoreline.ct ?? "—"} – ${match?.payload?.scoreline.t ?? "—"}`}
                    />
                    <div className="mt-2 flex gap-4">
                      <span className={`text-sm tabular-nums ${toneClass(ratingTone(you.rating))}`}>
                        {you.rating.toFixed(2)} rating
                      </span>
                      <span className={`text-sm tabular-nums ${toneClass(adrTone(you.adr))}`}>{you.adr} ADR</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
