import { useEffect, useMemo, useState } from "react";
import type { DoctorCheck, DoctorReport } from "../lib/types";
import { SectionHeader } from "../components/ui";

function needsToolsAction(check: DoctorCheck) {
  return check.action === "install" || check.action === "update";
}

export function DoctorPage() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setReport(await window.reel.doctor());
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    run();
  }, []);

  const toolAction = useMemo(() => {
    const checks = report?.checks ?? [];
    if (checks.some((c) => c.action === "install")) return "install" as const;
    if (checks.some((c) => c.action === "update")) return "update" as const;
    return null;
  }, [report]);

  const impacts = useMemo(
    () => (report?.checks ?? []).filter((c) => c.ok === false && c.impact),
    [report],
  );

  async function installOrUpdate() {
    setInstalling(true);
    setInstallMsg(null);
    setError(null);
    try {
      await window.reel.updateTools();
      setInstallMsg(toolAction === "update" ? "Tools refreshed. Re-checking…" : "Tools installed. Re-checking…");
      await run();
    } catch (err) {
      setError(String(err));
    } finally {
      setInstalling(false);
    }
  }

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <SectionHeader
        eyebrow="Environment"
        title="Doctor"
        action={
          <div className="flex flex-wrap gap-2">
            {toolAction && (
              <button
                type="button"
                disabled={installing || busy}
                onClick={installOrUpdate}
                className="rounded-full bg-amber px-4 py-2 text-sm font-semibold text-ink disabled:opacity-40"
              >
                {installing
                  ? "Working…"
                  : toolAction === "install"
                    ? "Install missing tools"
                    : "Update tools"}
              </button>
            )}
            <button
              type="button"
              onClick={run}
              disabled={busy || installing}
              className="rounded-full border border-line px-4 py-2 text-sm font-medium disabled:opacity-40"
            >
              {busy ? "Checking…" : "Re-check"}
            </button>
          </div>
        }
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      {installMsg && <p className="text-sm text-success">{installMsg}</p>}
      <p className="max-w-xl text-sm text-muted">
        HLAE and the CS2 plugin break after some game updates. Recording stays optional — Watch still copies
        <code className="mx-1 text-amber">playdemo name tick</code> for the console if CS2 is already open.
      </p>
      {impacts.length > 0 && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 px-5 py-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-danger">Won&apos;t work until fixed</p>
          <ul className="mt-2 space-y-1.5 text-sm text-fg">
            {impacts.map((check) => (
              <li key={check.name}>
                <span className="font-medium">{check.name}:</span> {check.impact}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="grid gap-2">
        {report?.checks.map((check) => (
          <div
            key={check.name}
            className={`flex items-start justify-between gap-4 rounded-xl border bg-panel/70 px-5 py-3 ${
              check.ok === false ? "border-danger/40" : "border-line"
            }`}
          >
            <div className="min-w-0 flex-1">
              <div className="font-medium">{check.name}</div>
              <div className="text-sm text-muted">{check.detail}</div>
              {check.hint && <div className="mt-1 text-xs text-amber">{check.hint}</div>}
              {check.ok === false && check.impact && (
                <div className="mt-1 text-xs text-danger">{check.impact}</div>
              )}
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <Status ok={check.ok} />
              {needsToolsAction(check) && (
                <button
                  type="button"
                  disabled={installing || busy}
                  onClick={installOrUpdate}
                  className="rounded-full bg-amber px-3 py-1 text-xs font-semibold text-ink disabled:opacity-40"
                >
                  {installing ? "…" : check.action === "install" ? "Install" : "Update"}
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Status({ ok }: { ok: boolean | null }) {
  if (ok === true) return <span className="text-sm font-medium text-success">OK</span>;
  if (ok === null) return <span className="text-sm text-amber">Optional</span>;
  return <span className="text-sm font-medium text-danger">Fail</span>;
}
