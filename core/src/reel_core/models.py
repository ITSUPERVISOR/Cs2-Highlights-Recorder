"""Shared models for parsing, scoring and recording."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Kill:
    tick: int
    round_index: int
    attacker_steamid: str
    attacker_name: str
    attacker_side: str
    victim_steamid: str
    victim_name: str
    weapon: str
    headshot: bool = False
    noscope: bool = False
    penetrated: int = 0
    thrusmoke: bool = False
    attackerblind: bool = False
    assister_steamid: str = ""

    @property
    def is_knife(self) -> bool:
        return "knife" in self.weapon or self.weapon == "bayonet"

    @property
    def is_zeus(self) -> bool:
        return self.weapon in ("taser", "zeus")

    @property
    def is_awp_noscope(self) -> bool:
        return self.weapon == "awp" and self.noscope

    @property
    def is_special(self) -> bool:
        return (
            self.is_knife
            or self.is_zeus
            or self.is_awp_noscope
            or self.thrusmoke
            or self.attackerblind
        )


@dataclass(frozen=True)
class Round:
    index: int
    start_tick: int
    freeze_end_tick: int
    end_tick: int
    winner: str
    ct_score: int = 0
    t_score: int = 0


@dataclass
class Clutch:
    steamid: str
    name: str
    side: str
    opponents: int
    won: bool
    kills: int
    start_tick: int
    end_tick: int
    round_index: int


@dataclass
class Moment:
    steamid: str
    name: str
    side: str
    round_index: int
    kills: list[Kill] = field(default_factory=list)
    clutch: Clutch | None = None
    score: float = 0.0
    labels: list[str] = field(default_factory=list)

    @property
    def kill_count(self) -> int:
        return len(self.kills)

    @property
    def first_tick(self) -> int:
        ticks = [k.tick for k in self.kills]
        if self.clutch is not None:
            ticks.append(self.clutch.start_tick)
        return min(ticks) if ticks else 0

    @property
    def last_tick(self) -> int:
        ticks = [k.tick for k in self.kills]
        if self.clutch is not None and self.clutch.won:
            ticks.append(self.clutch.end_tick)
        return max(ticks) if ticks else 0

    def describe(self) -> str:
        if self.labels:
            return " ".join(self.labels)
        parts: list[str] = []
        if self.kill_count >= 5:
            parts.append("ACE")
        elif self.kill_count:
            parts.append(f"{self.kill_count}K")
        if self.clutch is not None and self.clutch.won:
            parts.append(f"1v{self.clutch.opponents}")
        return " ".join(parts) if parts else "moment"


@dataclass(frozen=True)
class CameraAction:
    tick: int
    steamid: str


@dataclass
class Sequence:
    number: int
    start_tick: int
    end_tick: int
    cameras: list[CameraAction]
    label: str
    score: float
    round_index: int
    filename: str = ""
    moments: list[Moment] = field(default_factory=list)

    @property
    def name(self) -> str:
        return f"{self.number:02d}-sequence"

    def duration_seconds(self, tickrate: float) -> float:
        return (self.end_tick - self.start_tick) / tickrate

    @property
    def featured_steamids(self) -> list[str]:
        seen: list[str] = []
        for camera in self.cameras:
            if camera.steamid not in seen:
                seen.append(camera.steamid)
        return seen


@dataclass
class PlayerStats:
    steamid: str
    name: str
    side: str
    kills: int = 0
    deaths: int = 0
    assists: int = 0
    damage: int = 0
    headshots: int = 0
    kast_rounds: int = 0
    rounds: int = 0
    multi_3k: int = 0
    multi_4k: int = 0
    aces: int = 0
    clutch_attempts: int = 0
    clutch_wins: int = 0

    @property
    def adr(self) -> float:
        return round(self.damage / self.rounds, 1) if self.rounds else 0.0

    @property
    def kd(self) -> float:
        return round(self.kills / max(self.deaths, 1), 2)

    @property
    def kast(self) -> float:
        return round(100.0 * self.kast_rounds / self.rounds, 1) if self.rounds else 0.0

    @property
    def hs_percent(self) -> float:
        return round(100.0 * self.headshots / self.kills, 1) if self.kills else 0.0

    @property
    def rating(self) -> float:
        """Public HLTV 2.0 approximation (not the private official formula)."""
        if not self.rounds:
            return 0.0
        kpr = self.kills / self.rounds
        dpr = self.deaths / self.rounds
        apr = self.assists / self.rounds
        impact = 2.13 * kpr + 0.42 * apr - 0.41
        value = (
            0.0073 * self.kast
            + 0.3591 * kpr
            - 0.5329 * dpr
            + 0.2372 * impact
            + 0.0032 * self.adr
            + 0.1587
        )
        return round(value, 2)
