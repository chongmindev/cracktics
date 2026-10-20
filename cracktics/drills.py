"""Choosing drill positions: the board right before one of my mistakes, me to move.

A *mistake* item is a move that cost a lot while the game was still alive: the puzzle is to find a move as good
as the engine's. Must stay in step with web/src/rules.js (web/test/parity.test.js).
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import Iterable, Iterator

import chess

from .config import Config, DrillConfig
from .engine import Engine, Line
from .games import Game


@dataclass
class Ply:
    """One of my moves with evals around it. Evals are mine, clamped to +/- eval_cap."""
    game: Game
    move_number: int
    board: chess.Board          # position after my move, opponent to move
    move: chess.Move
    san: str
    best_san: str | None        # engine's choice instead of my move
    before: int
    after: int
    fen_before: str = ""        # position before my move, me to move (for the trainer's "fix it" step)
    prev: dict | None = None    # their move just before: {fen before it, from, to, san, promotion?} (the puzzle opens with it)

    @property
    def loss(self) -> int:
        return max(0, self.before - self.after)


def walk(game: Game, engine: Engine, depth: int, cap: int) -> Iterator[Ply]:
    """My moves in one game. Stops if my move ends the game."""
    clamp = lambda v: max(-cap, min(cap, v))
    board = chess.Board()
    line = engine.analyse(board, depth)[0]
    prev = None
    for i, mv in enumerate(game.moves):
        mine = board.turn == game.color
        prev_move = prev
        prev = {"fen": board.fen(), "from": chess.square_name(mv.from_square), "to": chess.square_name(mv.to_square),
                "san": board.san(mv), **({"promotion": chess.piece_symbol(mv.promotion)} if mv.promotion else {})}
        if mine:
            before = clamp(line.pov(game.color))
            best_san = board.san(chess.Move.from_uci(line.move)) if line.move else None
            san = board.san(mv)
            fen_before = board.fen()
        board.push(mv)
        if mine and board.is_game_over():
            return
        line = engine.analyse(board, depth)[0]
        if mine:
            yield Ply(game, i // 2 + 1, board.copy(stack=False), mv, san, best_san,
                      before, clamp(line.pov(game.color)), fen_before, prev_move)


def is_mistake_candidate(c: DrillConfig, p: Ply) -> bool:
    """It cost a lot, I wasn't already lost, and I wasn't still winning easily after it."""
    return (p.move_number >= c.mistake_min_move and p.before > c.mistake_min_before
            and p.after < c.mistake_max_after and p.loss >= c.mistake_min_loss)


def mistake_item(c: DrillConfig, p: Ply, lines: list[Line], reply: Line | None, cap: int) -> dict | None:
    """The puzzle. `lines` is MultiPV for me before my move; `reply` the opponent's best answer to my move.
    Accepted: moves within accept_within of the best that also beat my move by accept_min_gain."""
    me = p.game.color
    lines = [l for l in lines if l.move]
    if not lines:
        return None
    top = lines[0]
    mine = lambda l: max(-cap, min(cap, l.pov(me)))
    accept = [l for l in lines if l.move != p.move.uci()
              and mine(l) >= mine(top) - c.accept_within and mine(l) >= p.after + c.accept_min_gain]
    if not accept or accept[0] is not top:
        return None
    before = chess.Board(p.fen_before)
    mate = top.mate if top.mate is None or me == chess.WHITE else -top.mate
    return dict(_base(p), kind="mistake",
                accept=[l.move for l in accept],
                accept_san=[before.san(chess.Move.from_uci(l.move)) for l in accept],
                better=before.san(chess.Move.from_uci(top.move)),
                reply=p.board.san(chess.Move.from_uci(reply.move)) if reply and reply.move else None,
                mate=mate if mate and mate > 0 else None, swing=pawns(p.loss))


def pawns(cp: int) -> float:
    """Centipawns to pawns at one decimal, halves away from zero, in integers so the JS port matches exactly."""
    tenths = (abs(cp) + 5) // 10
    return (tenths if cp >= 0 else -tenths) / 10


def item_id(fen: str, move: chess.Move) -> str:
    """Stable across rebuilds, so spaced-repetition progress keeps pointing at the same position."""
    return hashlib.sha1(f"{fen} {move.uci()}".encode()).hexdigest()[:12]


def _base(p: Ply) -> dict:
    return {"id": item_id(p.board.fen(), p.move), "fen": p.board.fen(), "before_fen": p.fen_before,
            "color": "w" if p.game.color == chess.WHITE else "b",
            "from": chess.square_name(p.move.from_square), "to": chess.square_name(p.move.to_square),
            "san": p.san, "move": p.move_number, "opp": p.game.opponent, "date": p.game.date,
            "result": p.game.result, "evb": pawns(p.before), "eva": pawns(p.after),
            **({"link": link} if (link := p.game.headers.get("Link")) else {}),
            **({"prev_fen": p.prev["fen"], "prev": {k: v for k, v in p.prev.items() if k != "fen"}} if p.prev else {})}


def build_items(games: Iterable[Game], engine: Engine, cfg: Config) -> list[dict]:
    c, cap = cfg.drills, cfg.engine.eval_cap
    items = []
    for game in games:
        for p in walk(game, engine, c.depth, cap):
            if is_mistake_candidate(c, p):
                item = mistake_item(c, p, engine.analyse(chess.Board(p.fen_before), c.depth, c.multipv),
                                    engine.analyse(p.board, c.depth)[0], cap)
                if item:
                    items.append(item)
    return items
