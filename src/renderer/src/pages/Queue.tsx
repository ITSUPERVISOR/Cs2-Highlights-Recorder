import { useEffect, useState } from "react";
import { KillFeed } from "../components/KillFeed";
import type { DoctorReport, QueueItem } from "../lib/types";
import { Badge, Metric, SectionHeader } from "../components/ui";

export function QueuePage() {
  const [items, setItems] = useState<QueueItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [doctor, setDoctor] = useState<DoctorReport | null>(null);

  async function refresh() {
    setItems(await window.reel.listQueue());
  }

  useEffect(() => {
    refresh();
    window.reel.doctor().then(setDoctor).catch(() => undefined);
  }, []);

  const recordBlockers = (doctor?.checks ?? []).filter(
    (c) =>
      c.ok === false &&
      ["HLAE", "FFmpeg", "CS2 server plugin", "HLAE vs CS2 build", "gameinfo.gi writable", "CS2 installed"].includes(
        c.name,
      ),
  );
  const canInstall = (doctor?.checks ?? []).some((c) => c.action === "install" || c.action === "update");

  async function record() {
    setBusy("Recording via HLAE — keep CS2 focused. This takes roughly real time.");
    setResult(null);
    try {
      const payload = await window.reel.recordQueue();
      setResult(`Wrote ${payload.clips.length} clip(s) to ${payload.outDir}`);
      await refresh();
    } catch (err) {
      setResult(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function fixTools() {
    setBusy("Installing / updating recording tools…");
    setResult(null);
    try {
      await window.reel.updateTools();
      setDoctor(await window.reel.doctor());
      setResult("Tools updated. Check Doctor if Record still fails.");
    } catch (err) {
      setResult(String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <SectionHeader
        eyebrow="Record"
        title="Queue"
        action={
          <div className="flex gap-2">
            <button
              onClick={() => window.reel.clearQueue().then(setItems)}
              className="rounded-full border border-line px-4 py-2 text-sm font-medium"
            >
              Clear
            </button>
            <button
              disabled={!items.length || Boolean(busy)}
              onClick={record}
              className="rounded-full bg-amber px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            >
              Record selected
            </button>
          </div>
        }
      />
      {recordBlockers.length > 0 && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-5 py-4">
          <p className="text-sm font-medium text-danger">Record may not work</p>
          <ul className="mt-2 space-y-1 text-sm text-fg">
            {recordBlockers.map((check) => (
              <li key={check.name}>
                <span className="font-medium">{check.name}</span>
                {check.impact ? ` — ${check.impact}` : check.hint ? ` — ${check.hint}` : ""}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Watch still works. Use OBS if HLAE is blocked after a CS2 update.</p>
          {canInstall && (
            <button
              type="button"
              disabled={Boolean(busy)}
              onClick={fixTools}
              className="mt-3 rounded-full bg-amber px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
            >
              {busy?.includes("Installing") ? "Working…" : "Install / update tools"}
            </button>
          )}
        </div>
      )}
      {busy && <p className="text-sm text-amber">{busy}</p>}
      {result && <p className="text-sm text-muted">{result}</p>}
      <div className="grid gap-2">
        {items.length === 0 && (
          <div className="rounded-xl border border-dashed border-line px-8 py-14 text-center text-muted">
            Queue moments from a match review. If HLAE is broken after a CS2 update, use Watch and OBS.
          </div>
        )}
        {items.map((item) => (
          <article
            key={item.id}
            className="flex flex-col gap-3 rounded-xl border border-line bg-panel/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.moment.name}</span>
                <span className="text-xs text-muted">R{item.moment.round}</span>
                <Metric label="Clip score" value={item.moment.score.toFixed(1)} />
                {item.moment.durationSeconds != null && (
                  <span className="text-xs text-muted">{item.moment.durationSeconds.toFixed(1)}s</span>
                )}
                {(item.moment.labels ?? []).map((label) => (
                  <Badge key={label}>{label}</Badge>
                ))}
              </div>
              {item.moment.clutch && (
                <p className="mt-2 text-xs text-muted">
                  Clutch 1v{item.moment.clutch.opponents} · {item.moment.clutch.won ? "won" : "lost"}
                </p>
              )}
              <div className="mt-2">
                <KillFeed kills={item.moment.kills ?? []} />
              </div>
            </div>
            <button
              onClick={() => window.reel.removeFromQueue(item.id).then(setItems)}
              className="text-sm text-muted hover:text-fg"
            >
              Remove
            </button>
          </article>
        ))}
      </div>
    </div>
  );
}
