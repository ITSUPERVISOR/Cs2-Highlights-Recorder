import { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import initSqlJs, { type Database } from "sql.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const PREVIEW_IPC_MAX = 32 * 1024 * 1024;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "reelmap",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

type Settings = {
  steamId: string;
  askPlayerEveryTime: boolean;
  folders: string[];
  outputDir: string;
  pythonPath: string;
};

const DEFAULT_SETTINGS: Settings = {
  steamId: "",
  askPlayerEveryTime: true,
  folders: [],
  outputDir: join(homedir(), "Videos", "CS2 Reel"),
  pythonPath: "",
};

let db: Database;
let dbPath = "";
let mainWindow: BrowserWindow | null = null;

function persistDb() {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, Buffer.from(db.export()));
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS matches (
      id TEXT PRIMARY KEY,
      demo_path TEXT NOT NULL,
      map TEXT,
      imported_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      payload TEXT,
      recorded_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      match_id TEXT NOT NULL,
      moment_json TEXT NOT NULL,
      added_at INTEGER NOT NULL
    );
  `);
}

function getSettings(): Settings {
  const rows = db.exec("SELECT key, value FROM settings");
  const map: Record<string, string> = {};
  if (rows[0]) {
    for (const [key, value] of rows[0].values) {
      map[String(key)] = String(value);
    }
  }
  return {
    steamId: map.steamId ?? DEFAULT_SETTINGS.steamId,
    askPlayerEveryTime: map.askPlayerEveryTime == null ? true : map.askPlayerEveryTime === "true",
    folders: map.folders ? (JSON.parse(map.folders) as string[]) : [],
    outputDir: map.outputDir ?? DEFAULT_SETTINGS.outputDir,
    pythonPath: map.pythonPath ?? DEFAULT_SETTINGS.pythonPath,
  };
}

function setSettings(partial: Partial<Settings>) {
  const next = { ...getSettings(), ...partial };
  const entries: [string, string][] = [
    ["steamId", next.steamId],
    ["askPlayerEveryTime", next.askPlayerEveryTime ? "true" : "false"],
    ["folders", JSON.stringify(next.folders)],
    ["outputDir", next.outputDir],
    ["pythonPath", next.pythonPath],
  ];
  for (const [key, value] of entries) {
    db.run("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", [key, value]);
  }
  persistDb();
  return next;
}

function pythonBin(): string {
  const settings = getSettings();
  if (settings.pythonPath && existsSync(settings.pythonPath)) {
    return settings.pythonPath;
  }
  const venv = join(ROOT, "core", ".venv", "Scripts", "python.exe");
  if (existsSync(venv)) return venv;
  return "python";
}

function runCore(args: string[], timeoutMs = 180_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), ["-m", "reel_core", ...args], {
      cwd: join(ROOT, "core"),
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`reel-core timed out: ${args.join(" ")}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runCoreJson(args: string[], timeoutMs?: number) {
  const result = await runCore(args, timeoutMs);
  if (result.code !== 0 && !result.stdout.includes("{")) {
    throw new Error(result.stderr || result.stdout || `reel-core failed: ${args.join(" ")}`);
  }
  return parseJsonOutput(result.stdout);
}

function parseJsonOutput(stdout: string) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) {
    throw new Error(stdout || "core produced no JSON");
  }
  return JSON.parse(stdout.slice(start, end + 1));
}

function reelHome() {
  return resolve(process.env.CS2_REEL_HOME || join(process.env.LOCALAPPDATA || homedir(), "cs2-reel"));
}

function isUnderReelHome(filePath: string) {
  const root = reelHome();
  const resolved = resolve(filePath);
  if (process.platform === "win32") {
    const a = resolved.toLowerCase();
    const b = root.toLowerCase();
    return a === b || a.startsWith(`${b}\\`);
  }
  return resolved === root || resolved.startsWith(`${root}${sep}`);
}

function normalizeDemoPath(filePath: string) {
  return filePath.replace(/\\/g, "/").toLowerCase();
}

function listDemoFiles(folders: string[]) {
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const byPath = new Map<string, { path: string; size: number; mtime: number }>();
  const exts = [".dem", ".dem.gz", ".dem.zst"];
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    const walk = (dir: string, depth: number) => {
      if (depth > 4) return;
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = join(dir, name);
        let stat;
        try {
          stat = statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (exts.some((ext) => name.toLowerCase().endsWith(ext))) {
          byPath.set(normalizeDemoPath(full), { path: full, size: stat.size, mtime: stat.mtimeMs });
        }
      }
    };
    walk(folder, 0);
  }
  return [...byPath.values()];
}

function importNewDemos() {
  const settings = getSettings();
  const files = listDemoFiles(settings.folders);
  const known = new Set(
    (db.exec("SELECT id, demo_path FROM matches")[0]?.values ?? []).flatMap((row) => [
      String(row[0]),
      normalizeDemoPath(String(row[1])),
    ]),
  );
  for (const file of files) {
    const id = normalizeDemoPath(file.path);
    if (known.has(id) || known.has(file.path)) continue;
    db.run(
      "INSERT OR IGNORE INTO matches (id, demo_path, map, imported_at, status) VALUES (?, ?, ?, ?, ?)",
      [id, file.path, null, Date.now(), "new"],
    );
    known.add(id);
    known.add(file.path);
  }
  persistDb();
  return listMatches();
}

const folderWatchers: ReturnType<typeof watch>[] = [];
let scanTimer: ReturnType<typeof setTimeout> | null = null;

function armFolderWatch() {
  for (const watcher of folderWatchers.splice(0)) {
    watcher.close();
  }
  for (const folder of getSettings().folders) {
    if (!existsSync(folder)) continue;
    try {
      folderWatchers.push(
        watch(folder, { recursive: true }, () => {
          if (scanTimer) clearTimeout(scanTimer);
          scanTimer = setTimeout(() => {
            importNewDemos();
            mainWindow?.webContents.send("library:changed");
          }, 800);
        }),
      );
    } catch {
      // Watching can fail on some network paths; Scan still works.
    }
  }
}

function preloadScript() {
  const candidates = [
    join(__dirname, "../preload/preload.cjs"),
    join(__dirname, "../preload/preload.js"),
    join(__dirname, "../preload/index.js"),
    join(__dirname, "../preload/index.cjs"),
  ];
  return candidates.find((file) => existsSync(file)) ?? candidates[0];
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0b0c0f",
    title: "Reel",
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadScript(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error("Renderer failed to load", code, desc, url);
  });
  mainWindow.webContents.on("render-process-gone", (_e, details) => {
    console.error("Renderer crashed", details.reason, details.exitCode);
  });
  mainWindow.webContents.on("unresponsive", () => {
    console.error("Renderer unresponsive");
  });
  mainWindow.webContents.on("console-message", (event) => {
    const level = event.level;
    if (level !== "warning" && level !== "error") return;
    const tag = level === "error" ? "error" : "warn";
    console.error(`[renderer ${tag}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

process.on("uncaughtException", (err) => {
  console.error("uncaughtException", err);
});
process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection", err);
});

app.whenReady().then(async () => {
  protocol.handle("reelmap", (request) => {
    try {
      const filePath = decodeURIComponent(new URL(request.url).searchParams.get("path") || "");
      if (!filePath || !isUnderReelHome(filePath) || !existsSync(filePath)) {
        return new Response("not found", { status: 404 });
      }
      return net.fetch(pathToFileURL(filePath).href);
    } catch {
      return new Response("bad request", { status: 400 });
    }
  });
  const SQL = await initSqlJs({
    locateFile: (file: string) => join(ROOT, "node_modules", "sql.js", "dist", file),
  });
  dbPath = join(app.getPath("userData"), "reel.sqlite");
  if (existsSync(dbPath)) {
    db = new SQL.Database(readFileSync(dbPath));
  } else {
    db = new SQL.Database();
  }
  initSchema();
  persistDb();
  armFolderWatch();

  ipcMain.handle("settings:get", () => getSettings());
  ipcMain.handle("settings:set", (_e, partial: Partial<Settings>) => {
    const next = setSettings(partial);
    armFolderWatch();
    return next;
  });
  ipcMain.handle("dialog:folder", async () => {
    const res = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle("dialog:file", async () => {
    const res = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "CS2 demos", extensions: ["dem", "gz", "zst"] }],
    });
    return res.canceled ? [] : res.filePaths;
  });
  ipcMain.handle("clipboard:write", (_e, text: string) => {
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle("shell:openPath", (_e, p: string) => shell.openPath(p));
  ipcMain.handle("shell:openUrl", (_e, url: string) => {
    if (typeof url === "string" && (url.startsWith("https://") || url.startsWith("http://"))) {
      return shell.openExternal(url);
    }
    return false;
  });

  ipcMain.handle("core:doctor", async () => {
    const result = await runCore(["doctor", "--json"]);
    if (result.code !== 0 && !result.stdout.includes("{")) {
      throw new Error(result.stderr || result.stdout || "doctor failed");
    }
    const payload = parseJsonOutput(result.stdout);
    const settings = getSettings();
    if (!settings.steamId && payload.steamid) {
      setSettings({ steamId: payload.steamid });
    }
    if (payload.replaysDir && !settings.folders.includes(payload.replaysDir)) {
      setSettings({ folders: [...settings.folders, payload.replaysDir] });
    }
    return payload;
  });

  ipcMain.handle("core:detectSteamid", async () => {
    const result = await runCore(["detect-steamid", "--json"]);
    return parseJsonOutput(result.stdout);
  });

  ipcMain.handle("core:updateTools", async () => {
    const result = await runCore(["update-tools", "--json"], 600_000);
    if (result.code !== 0 && !result.stdout.includes("{")) {
      throw new Error(result.stderr || result.stdout || "update-tools failed");
    }
    return parseJsonOutput(result.stdout);
  });

  ipcMain.handle("library:scan", () => {
    const matches = importNewDemos();
    armFolderWatch();
    return matches;
  });

  ipcMain.handle("library:list", () => listMatches());
  ipcMain.handle("library:get", (_e, id: string) => getMatch(id));
  ipcMain.handle("library:status", (_e, id: string, status: string) => {
    db.run("UPDATE matches SET status = ? WHERE id = ?", [status, id]);
    persistDb();
    return getMatch(id);
  });

  ipcMain.handle("library:analyze", async (_e, id: string) => {
    const match = getMatch(id);
    if (!match) throw new Error("match not found");
    const args = ["parse", match.demoPath, "--json", "--all-players"];
    const result = await runCore(args, 300_000);
    if (result.code !== 0) {
      throw new Error(result.stderr || result.stdout || "parse failed");
    }
    const payload = parseJsonOutput(result.stdout);
    db.run("UPDATE matches SET payload = ?, map = ?, status = ? WHERE id = ?", [
      JSON.stringify(payload),
      payload.map ?? null,
      "parsed",
      id,
    ]);
    persistDb();
    return getMatch(id);
  });

  ipcMain.handle("library:setPlayer", (_e, id: string, steamid: string) => {
    const match = getMatch(id);
    if (!match?.payload) throw new Error("match not found");
    const payload = applyPlayerFocus(match.payload, steamid);
    db.run("UPDATE matches SET payload = ?, status = ? WHERE id = ?", [
      JSON.stringify(payload),
      "reviewed",
      id,
    ]);
    persistDb();
    return getMatch(id);
  });

  ipcMain.handle("queue:list", () => listQueue());
  ipcMain.handle("queue:add", (_e, matchId: string, moment: unknown) => {
    const id = `${matchId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    db.run("INSERT INTO queue (id, match_id, moment_json, added_at) VALUES (?, ?, ?, ?)", [
      id,
      matchId,
      JSON.stringify(moment),
      Date.now(),
    ]);
    persistDb();
    return listQueue();
  });
  ipcMain.handle("queue:remove", (_e, id: string) => {
    db.run("DELETE FROM queue WHERE id = ?", [id]);
    persistDb();
    return listQueue();
  });
  ipcMain.handle("queue:clear", () => {
    db.run("DELETE FROM queue");
    persistDb();
    return [];
  });

  ipcMain.handle("preview:readFile", (_e, filePath: string) => {
    if (typeof filePath !== "string") return null;
    const resolved = resolve(filePath);
    if (!isUnderReelHome(resolved) || !existsSync(resolved)) return null;
    if (statSync(resolved).size > PREVIEW_IPC_MAX) return null;
    return readFileSync(resolved);
  });
  ipcMain.handle(
    "core:previewClip",
    async (
      _e,
      demoPath: string,
      startTick: number,
      endTick: number,
      steamid: string,
      mapName?: string,
      tickrate?: number,
    ) => {
      const args = [
        "preview",
        demoPath,
        "--start",
        String(startTick),
        "--end",
        String(endTick),
        "--player",
        steamid,
        "--json",
      ];
      if (mapName) args.push("--map-name", mapName);
      if (tickrate) args.push("--tickrate", String(tickrate));
      const result = await runCore(args, 300_000);
      if (result.code !== 0 && !result.stdout.includes("{")) {
        throw new Error(result.stderr || result.stdout || "preview failed");
      }
      const meta = parseJsonOutput(result.stdout || result.stderr);
      const cachePath = String(meta.cachePath || "");
      if (!cachePath || !existsSync(cachePath)) {
        throw new Error(result.stderr || "preview produced no pose cache");
      }
      return JSON.parse(readFileSync(cachePath, "utf8"));
    },
  );
  ipcMain.handle("core:previewMap", async (_e, mapName: string) => {
    const result = await runCore(["preview-map", String(mapName || ""), "--json"], 600_000);
    if (result.code !== 0 && !result.stdout.includes("{")) {
      throw new Error(result.stderr || result.stdout || "map export failed");
    }
    return parseJsonOutput(result.stdout || result.stderr);
  });

  // The spec goes via a file: the animation list is dozens of long paths, which
  // would be at risk of the command-line length limit.
  ipcMain.handle("core:previewAssets", async (_e, spec: unknown) => {
    const specPath = join(app.getPath("temp"), "reel-assets-spec.json");
    writeFileSync(specPath, JSON.stringify(spec ?? {}));
    const result = await runCore(["preview-assets", "--spec", specPath, "--json"], 900_000);
    if (result.code !== 0 && !result.stdout.includes("{")) {
      throw new Error(result.stderr || result.stdout || "asset export failed");
    }
    return parseJsonOutput(result.stdout || result.stderr);
  });

  ipcMain.handle("core:watch", async (_e, demoPath: string, tick: number, steamid?: string) => {
    const settings = getSettings();
    const args = ["watch", demoPath, "--tick", String(tick), "--json"];
    const pov = steamid || settings.steamId;
    if (pov) args.push("--player", pov);
    const result = await runCore(args, 30_000);
    const payload = parseJsonOutput(result.stdout || result.stderr);
    if (payload.copyText) clipboard.writeText(payload.copyText);
    return payload;
  });

  ipcMain.handle("core:record", async () => {
    const settings = getSettings();
    const queue = listQueue();
    if (!queue.length) throw new Error("Queue is empty");
    mkdirSync(settings.outputDir, { recursive: true });
    const byMatch = new Map<string, { demoPath: string; moments: unknown[] }>();
    for (const item of queue) {
      const match = getMatch(item.matchId);
      if (!match) continue;
      const bucket = byMatch.get(match.id) ?? { demoPath: match.demoPath, moments: [] };
      bucket.moments.push(item.moment);
      byMatch.set(match.id, bucket);
    }
    const clips: string[] = [];
    for (const [matchId, job] of byMatch) {
      const momentsPath = join(app.getPath("temp"), `reel-moments-${matchId.replace(/[^\w]/g, "")}.json`);
      writeFileSync(momentsPath, JSON.stringify(job.moments, null, 2));
      const args = ["record", job.demoPath, "--moments", momentsPath, "--out", settings.outputDir, "--json"];
      if (settings.steamId) args.push("--player", settings.steamId);
      const result = await runCore(args, 3_600_000);
      if (result.code !== 0) {
        throw new Error(result.stderr || result.stdout || "record failed");
      }
      const payload = parseJsonOutput(result.stdout);
      clips.push(...(payload.clips ?? []));
      db.run("UPDATE matches SET recorded_count = recorded_count + ?, status = ? WHERE id = ?", [
        job.moments.length,
        "recorded",
        matchId,
      ]);
    }
    db.run("DELETE FROM queue");
    persistDb();
    return { clips, outDir: settings.outputDir };
  });

  createWindow();
});

function applyPlayerFocus(payload: Record<string, unknown>, steamid: string) {
  const players = (payload.players as { steamid?: string }[] | undefined) ?? [];
  const you = players.find((player) => player.steamid === steamid) ?? null;
  const moments = (payload.moments as { steamid?: string }[] | undefined) ?? [];
  const highlightCount = moments.filter((moment) => moment.steamid === steamid).length;
  return { ...payload, playerSteamid: steamid, you, highlightCount };
}

function listMatches() {
  const rows = db.exec(
    "SELECT id, demo_path, map, imported_at, status, payload, recorded_count FROM matches ORDER BY imported_at DESC",
  );
  if (!rows[0]) return [];
  return rows[0].values.map((row) => rowToMatch(row));
}

function getMatch(id: string) {
  return listMatches().find((match) => match.id === id) ?? null;
}

function rowToMatch(row: unknown[]) {
  const payloadRaw = row[5] ? String(row[5]) : null;
  return {
    id: String(row[0]),
    demoPath: String(row[1]),
    map: row[2] ? String(row[2]) : null,
    importedAt: Number(row[3]),
    status: String(row[4]),
    payload: payloadRaw ? JSON.parse(payloadRaw) : null,
    recordedCount: Number(row[6] ?? 0),
  };
}

function listQueue() {
  const rows = db.exec("SELECT id, match_id, moment_json, added_at FROM queue ORDER BY added_at ASC");
  if (!rows[0]) return [];
  return rows[0].values.map((row) => ({
    id: String(row[0]),
    matchId: String(row[1]),
    moment: JSON.parse(String(row[2])),
    addedAt: Number(row[3]),
  }));
}

app.on("window-all-closed", () => {
  persistDb();
  app.quit();
});
