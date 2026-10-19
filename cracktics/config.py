"""Typed settings loaded from config.toml."""
from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, fields
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parent.parent / "config.toml"


@dataclass(frozen=True)
class EngineConfig:
    path: str
    threads: int
    hash_mb: int
    cache: str
    mate_score: int
    eval_cap: int


@dataclass(frozen=True)
class FetchConfig:
    base_url: str
    user_agent: str
    cache: str
    min_interval: float
    timeout: int
    retries: int
    backoff: float
    months: int
    time_classes: tuple[str, ...]


@dataclass(frozen=True)
class ScanConfig:
    screen_depth: int
    screen_margin: int


@dataclass(frozen=True)
class TrainerConfig:
    fix_tolerance: int


@dataclass(frozen=True)
class ReportConfig:
    depth: int
    error_loss: int
    cpl_cap: int
    hung_min_value: int
    early_queen_moves: int
    missed_win_before: int
    missed_win_loss: int


@dataclass(frozen=True)
class SummaryConfig:
    opening_end: int
    middlegame_end: int
    big_blunder: int
    opening_plies: int


@dataclass(frozen=True)
class DrillConfig:
    depth: int
    multipv: int
    seed: int
    threat_min_loss: int
    threat_min_before: int
    threat_min_move: int
    accept_within: int
    accept_min_gain: int
    safe_max_loss: int
    safe_min_move: int
    safe_after_min: int
    safe_after_max: int
    safe_max_opp_eval: int
    safe_sample_rate: float
    safe_ratio: float


@dataclass(frozen=True)
class ScoutConfig:
    """Scout (web only): an opponent's opening tree, weak spots and habits."""
    plies: int
    half_life_days: int
    min_games: int
    weak_gap: float
    weak_spots: int
    family_min_games: int
    habit_min_games: int
    habit_min_share: float
    dubious_loss: int
    slip_loss: int
    blunder_loss: int
    slip_depth: int
    exploit_min_games: int
    move_check_max: int
    plan_max: int
    plan_depth: int
    plan_loss_cap: int


@dataclass(frozen=True)
class Config:
    engine: EngineConfig
    fetch: FetchConfig
    scan: ScanConfig
    trainer: TrainerConfig
    report: ReportConfig
    summary: SummaryConfig
    drills: DrillConfig
    scout: ScoutConfig


def _build(cls, table: dict, section: str):
    names = {f.name for f in fields(cls)}
    missing, extra = names - table.keys(), table.keys() - names
    if missing or extra:
        raise ValueError(f"[{section}] missing {sorted(missing)}, unknown {sorted(extra)}")
    return cls(**table)


def load(path: str | Path | None = None) -> Config:
    """Relative cache paths resolve against the config file's folder, so the MCP server works from any cwd."""
    path = Path(path or DEFAULT_PATH).resolve()
    raw = tomllib.loads(path.read_text())
    here = lambda p: str(path.parent / p)
    engine = dict(raw["engine"], cache=here(raw["engine"]["cache"]))
    engine["path"] = os.environ.get("STOCKFISH", engine["path"])
    raw["fetch"] = dict(raw["fetch"], cache=here(raw["fetch"]["cache"]))
    return Config(
        engine=_build(EngineConfig, engine, "engine"),
        fetch=_build(FetchConfig, {**raw["fetch"], "time_classes": tuple(raw["fetch"]["time_classes"])}, "fetch"),
        scan=_build(ScanConfig, raw["scan"], "scan"),
        trainer=_build(TrainerConfig, raw["trainer"], "trainer"),
        report=_build(ReportConfig, raw["report"], "report"),
        summary=_build(SummaryConfig, raw["summary"], "summary"),
        drills=_build(DrillConfig, raw["drills"], "drills"),
        scout=_build(ScoutConfig, raw["scout"], "scout"),
    )
