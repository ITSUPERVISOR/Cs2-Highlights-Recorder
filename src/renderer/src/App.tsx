import { useState } from "react";
import { DoctorPage } from "./pages/Doctor";
import { LibraryPage } from "./pages/Library";
import { MatchPage } from "./pages/Match";
import { QueuePage } from "./pages/Queue";
import { SettingsPage } from "./pages/Settings";
import { StatsPage } from "./pages/Stats";
import type { MatchRow } from "./lib/types";

type Tab = "library" | "queue" | "stats" | "doctor" | "settings";

const NAV: { id: Tab; label: string; icon: string }[] = [
  { id: "library", label: "Library", icon: "▦" },
  { id: "queue", label: "Queue", icon: "◎" },
  { id: "stats", label: "Stats", icon: "▴" },
  { id: "doctor", label: "Doctor", icon: "⊕" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("library");
  const [match, setMatch] = useState<MatchRow | null>(null);
  const [queueCount, setQueueCount] = useState(0);

  function openMatch(row: MatchRow) {
    setMatch(row);
    setTab("library");
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-48 shrink-0 flex-col border-r border-line bg-panel/90 px-3 py-5 backdrop-blur">
        <div className="px-2">
          <div className="font-display text-xl font-semibold tracking-tight text-amber">Reel</div>
          <div className="mt-0.5 text-[11px] text-muted">CS2 clip desk</div>
        </div>
        <nav className="mt-8 flex flex-col gap-0.5">
          {NAV.map((item) => {
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  if (item.id !== "library") setMatch(null);
                  setTab(item.id);
                  if (item.id === "queue") {
                    window.reel.listQueue().then((q) => setQueueCount(q.length));
                  }
                }}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition ${
                  active
                    ? "bg-raised text-fg shadow-[inset_2px_0_0_0_var(--color-amber)]"
                    : "text-muted hover:bg-raised/50 hover:text-fg"
                }`}
              >
                <span className="w-4 text-center text-xs opacity-70">{item.icon}</span>
                <span className="flex-1 font-medium">{item.label}</span>
                {item.id === "queue" && queueCount > 0 && (
                  <span className="rounded-full bg-amber/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber">
                    {queueCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="mt-auto px-2 pt-6 text-[10px] leading-relaxed text-muted/70">
          Parse → pick player → queue → record
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-hidden">
        {tab === "library" && !match && <LibraryPage onOpen={openMatch} />}
        {tab === "library" && match && (
          <MatchPage
            match={match}
            onBack={() => setMatch(null)}
            onMatchChange={setMatch}
            onQueued={() => {
              window.reel.listQueue().then((q) => setQueueCount(q.length));
            }}
          />
        )}
        {tab === "queue" && <QueuePage />}
        {tab === "stats" && <StatsPage />}
        {tab === "doctor" && <DoctorPage />}
        {tab === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}
