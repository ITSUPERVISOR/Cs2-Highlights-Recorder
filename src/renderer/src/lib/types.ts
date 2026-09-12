export type PlayerStats = {
  steamid: string;
  name: string;
  side: string;
  kills: number;
  deaths: number;
  assists: number;
  adr: number;
  kd: number;
  kast: number;
  rating: number;
  hsPercent: number;
  multi3k: number;
  multi4k: number;
  aces: number;
  clutchAttempts: number;
  clutchWins: number;
};

export type Kill = {
  tick: number;
  attackerSteamid: string;
  attackerName: string;
  victimSteamid: string;
  victimName: string;
  weapon: string;
  headshot: boolean;
  noscope: boolean;
  thrusmoke: boolean;
  flashed: boolean;
  wallbang: boolean;
};

export type Moment = {
  id: string;
  steamid: string;
  name: string;
  side: string;
  round: number;
  roundIndex: number;
  score: number;
  labels: string[];
  kills: Kill[];
  firstTick: number;
  lastTick: number;
  durationSeconds: number;
  clutch: { opponents: number; won: boolean; kills: number; startTick: number } | null;
};

export type Round = {
  number: number;
  index: number;
  startTick: number;
  freezeEndTick: number;
  endTick: number;
  winner: string;
  ctScore: number;
  tScore: number;
  score: number;
  labels: string[];
  moments: Moment[];
};

export type ReelSettings = {
  steamId: string;
  askPlayerEveryTime: boolean;
  folders: string[];
  outputDir: string;
  pythonPath: string;
};

export type ParsePayload = {
  demoPath: string;
  map: string;
  tickrate: number;
  scoreline: { ct: number; t: number };
  playerSteamid: string | null;
  you: PlayerStats | null;
  players: PlayerStats[];
  rounds: Round[];
  moments: Moment[];
  highlightCount: number;
};

export type MatchRow = {
  id: string;
  demoPath: string;
  map: string | null;
  importedAt: number;
  status: string;
  payload: ParsePayload | null;
  recordedCount: number;
};

export type QueueItem = {
  id: string;
  matchId: string;
  moment: Moment;
  addedAt: number;
};

export type DoctorCheck = {
  name: string;
  ok: boolean | null;
  detail: string;
  hint: string;
  impact?: string;
  action?: "install" | "update" | null;
};

export type SteamAccount = {
  steamid: string;
  accountName: string;
  personaName: string;
  mostRecent: boolean;
  timestamp: number;
};

export type DoctorReport = {
  ok: boolean;
  steamid: string | null;
  accounts?: SteamAccount[];
  replaysDir: string | null;
  cs2Folder: string | null;
  checks: DoctorCheck[];
};
