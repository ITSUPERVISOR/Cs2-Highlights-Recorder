import { useEffect, useState } from "react";
import type { PreviewQuality, ReelSettings, SteamAccount } from "../lib/types";
import { SectionHeader } from "../components/ui";

const QUALITY_OPTIONS: { id: PreviewQuality; label: string; hint: string }[] = [
  { id: "low", label: "Low", hint: "Collision hull. Fastest first paint." },
  { id: "medium", label: "Medium", hint: "Hull plus local radar tint and overlay." },
  { id: "high", label: "High", hint: "Same radar hull as Medium. The CS2 world mesh is too large to load." },
];

export function SettingsPage() {
  const [settings, setSettings] = useState<ReelSettings | null>(null);
  const [accounts, setAccounts] = useState<SteamAccount[]>([]);

  useEffect(() => {
    window.reel.getSettings().then(setSettings);
    window.reel.detectSteamid().then((payload: { accounts?: SteamAccount[] }) => {
      setAccounts(payload.accounts ?? []);
    }).catch(() => undefined);
  }, []);

  if (!settings) return null;

  async function save(partial: Partial<ReelSettings>) {
    const next = await window.reel.setSettings(partial);
    setSettings(next);
  }

  const remembered = accounts.find((account) => account.steamid === settings.steamId);

  return (
    <div className="flex h-full flex-col gap-6 overflow-auto p-8">
      <SectionHeader eyebrow="Preferences" title="Settings" />
      <section className="max-w-xl">
        <span className="text-xs uppercase tracking-widest text-muted">Your player</span>
        <p className="mt-2 text-sm text-muted">
          After a demo is parsed you pick who to score. Remember that player, or keep choosing each time.
        </p>
        <div className="mt-3 grid gap-2">
          <button
            type="button"
            onClick={() => save({ askPlayerEveryTime: false })}
            className={`rounded-2xl border px-4 py-3 text-left ${
              !settings.askPlayerEveryTime && settings.steamId
                ? "border-amber bg-raised"
                : "border-line hover:border-amber/40"
            }`}
          >
            <div className="font-medium">Remember my account</div>
            <div className="mt-1 text-sm text-muted">
              {remembered
                ? `Skip the picker when ${remembered.personaName} is in the demo.`
                : settings.steamId
                  ? `Skip the picker when ${settings.steamId} is in the demo.`
                  : "Pick a player on the next demo, then choose Remember."}
            </div>
          </button>
          <button
            type="button"
            onClick={() => save({ askPlayerEveryTime: true })}
            className={`rounded-2xl border px-4 py-3 text-left ${
              settings.askPlayerEveryTime ? "border-amber bg-raised" : "border-line hover:border-amber/40"
            }`}
          >
            <div className="font-medium">Ask which player every time</div>
            <div className="mt-1 text-sm text-muted">
              Show the roster after each parse. Accounts on this PC are marked.
            </div>
          </button>
        </div>
        {accounts.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2">
            {accounts.map((account) => (
              <button
                key={account.steamid}
                type="button"
                onClick={() => save({ steamId: account.steamid, askPlayerEveryTime: false })}
                className={`rounded-full border px-3 py-1 text-xs ${
                  settings.steamId === account.steamid && !settings.askPlayerEveryTime
                    ? "border-amber bg-amber text-ink"
                    : "border-line text-muted hover:border-amber"
                }`}
              >
                {account.personaName || account.accountName || account.steamid}
              </button>
            ))}
          </div>
        )}
        <label className="mt-4 block">
          <span className="text-xs uppercase tracking-widest text-muted">SteamID64</span>
          <input
            value={settings.steamId}
            onChange={(e) => setSettings({ ...settings, steamId: e.target.value })}
            onBlur={() => save({ steamId: settings.steamId })}
            className="mt-2 w-full rounded-xl border border-line bg-raised px-3 py-2 outline-none focus:border-amber"
          />
        </label>
      </section>
      <div className="max-w-xl">
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-widest text-muted">Demo folders</span>
          <button
            className="text-sm text-amber"
            onClick={async () => {
              const folder = await window.reel.pickFolder();
              if (folder) save({ folders: [...settings.folders, folder] });
            }}
          >
            Add folder
          </button>
        </div>
        <ul className="mt-2 space-y-2">
          {settings.folders.map((folder) => (
            <li key={folder} className="flex items-center justify-between rounded-xl border border-line bg-panel px-3 py-2 text-sm">
              <span className="truncate">{folder}</span>
              <button
                className="text-muted"
                onClick={() => save({ folders: settings.folders.filter((f) => f !== folder) })}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      </div>
      <section className="max-w-xl">
        <span className="text-xs uppercase tracking-widest text-muted">Preview</span>
        <p className="mt-2 text-sm text-muted">
          Map quality is remembered across launches. First run is Low. Open Preview to tweak the
          viewmodel live — offsets, FOV, and scale apply while the clip is playing.
        </p>
        <div className="mt-3 grid gap-2">
          {QUALITY_OPTIONS.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => save({ previewQuality: option.id })}
              className={`rounded-2xl border px-4 py-3 text-left ${
                settings.previewQuality === option.id || (!settings.previewQuality && option.id === "low")
                  ? "border-amber bg-raised"
                  : "border-line hover:border-amber/40"
              }`}
            >
              <div className="font-medium">{option.label}</div>
              <div className="mt-1 text-sm text-muted">{option.hint}</div>
            </button>
          ))}
        </div>
      </section>
      <label className="block max-w-xl">
        <span className="text-xs uppercase tracking-widest text-muted">Clip output folder</span>
        <div className="mt-2 flex gap-2">
          <input
            value={settings.outputDir}
            readOnly
            className="w-full rounded-xl border border-line bg-raised px-3 py-2"
          />
          <button
            className="rounded-xl border border-line px-3 text-sm"
            onClick={async () => {
              const folder = await window.reel.pickFolder();
              if (folder) save({ outputDir: folder });
            }}
          >
            Browse
          </button>
        </div>
      </label>
    </div>
  );
}
