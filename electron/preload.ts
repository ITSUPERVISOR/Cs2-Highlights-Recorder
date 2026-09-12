import { contextBridge, ipcRenderer } from "electron";

const api = {
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke("settings:set", partial),
  pickFolder: () => ipcRenderer.invoke("dialog:folder"),
  pickFiles: () => ipcRenderer.invoke("dialog:file"),
  copyText: (text: string) => ipcRenderer.invoke("clipboard:write", text),
  openPath: (path: string) => ipcRenderer.invoke("shell:openPath", path),
  doctor: () => ipcRenderer.invoke("core:doctor"),
  updateTools: () => ipcRenderer.invoke("core:updateTools"),
  detectSteamid: () => ipcRenderer.invoke("core:detectSteamid"),
  scanLibrary: () => ipcRenderer.invoke("library:scan"),
  listMatches: () => ipcRenderer.invoke("library:list"),
  getMatch: (id: string) => ipcRenderer.invoke("library:get", id),
  setStatus: (id: string, status: string) => ipcRenderer.invoke("library:status", id, status),
  analyze: (id: string) => ipcRenderer.invoke("library:analyze", id),
  choosePlayer: (id: string, steamid: string) => ipcRenderer.invoke("library:setPlayer", id, steamid),
  listQueue: () => ipcRenderer.invoke("queue:list"),
  addToQueue: (matchId: string, moment: unknown) => ipcRenderer.invoke("queue:add", matchId, moment),
  removeFromQueue: (id: string) => ipcRenderer.invoke("queue:remove", id),
  clearQueue: () => ipcRenderer.invoke("queue:clear"),
  watch: (demoPath: string, tick: number, steamid?: string) =>
    ipcRenderer.invoke("core:watch", demoPath, tick, steamid),
  recordQueue: () => ipcRenderer.invoke("core:record"),
  onLibraryChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
};

contextBridge.exposeInMainWorld("reel", api);

export type ReelApi = typeof api;
