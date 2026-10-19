import io
from dataclasses import replace
import shutil

import chess
import pytest

from cracktics import config
from cracktics.drills import Ply, build_items, is_mistake_candidate, item_id, mistake_item, walk
from cracktics.engine import Engine, Line
from cracktics.games import Game, read_games

CFG = config.load()
D, CAP = CFG.drills, CFG.engine.eval_cap


def game_from(sans: str, color=chess.BLACK, result="0-1") -> Game:
    board, moves = chess.Board(), []
    for san in sans.split():
        moves.append(board.push_san(san))
    me, them = ("me", "them") if color == chess.WHITE else ("them", "me")
    return Game({"White": me, "Black": them, "Date": "2026.10.01", "Result": result}, moves, color)


def ply_after(sans: str, color=chess.BLACK, before=0, after=-500, best="Nf6") -> Ply:
    """The position after the last move in `sans`, which is mine."""
    g = game_from(sans, color)
    board = chess.Board()
    for mv in g.moves[:-1]:
        board.push(mv)
    san, fen_before = board.san(g.moves[-1]), board.fen()
    board.push(g.moves[-1])
    return Ply(g, (len(g.moves) + 1) // 2, board, g.moves[-1], san, best, before, after, fen_before)


# --- pure selection rules, fake engine lines -----------------------------------------

def test_mistake_item_is_the_position_before_my_move_with_close_alternatives():
    # 1.e4 e5 2.Qh5 Nc6 3.Bc4 Nf6?? (4.Qxf7#): before Nf6, g6 and Qe7 hold; Nf6 is the move I played
    p = ply_after("e4 e5 Qh5 Nc6 Bc4 Nf6", before=-20, after=-2000, best="g6")
    lines = [Line("g7g6", -20, None), Line("d8e7", 10, None), Line("d7d5", 300, None)]   # White's view
    item = mistake_item(D, p, lines, Line("h5f7", 10000, 1), CAP)
    assert item["kind"] == "mistake" and item["color"] == "b"
    assert item["better"] == "g6" and item["accept"] == ["g7g6", "d8e7"] and item["accept_san"] == ["g6", "Qe7"]
    assert item["reply"] == "Qxf7#" and item["san"] == "Nf6" and item["swing"] == 19.8
    assert item["before_fen"] == p.fen_before and item["mate"] is None


def test_mistake_item_never_accepts_the_move_I_played_and_needs_the_best_move_first():
    p = ply_after("e4 e5 Qh5 Nc6 Bc4 Nf6", before=-20, after=-2000)
    assert mistake_item(D, p, [Line("g8f6", 20, None), Line("g7g6", 10, None)], None, CAP) is None
    assert mistake_item(D, p, [Line(None, 0, None)], None, CAP) is None


def test_mistake_item_answers_must_beat_my_move():
    p = ply_after("e4 e5 Nf3 Nc6 Bc4 Nf6", before=0, after=-120)
    lines = [Line("f8c5", 0, None), Line("f8e7", 60, None)]   # Be7 is close to the best but barely beats my move
    item = mistake_item(D, p, lines, None, CAP)
    assert item["accept"] == ["f8c5"]


def test_mistake_mate_is_mine_when_I_am_white():
    p = ply_after("e4 e5 Qh5 Nc6 Qxe5+", color=chess.WHITE, before=300, after=-900, best="Bc4")
    item = mistake_item(D, p, [Line("f1c4", 10000, 3)], Line("c6e5", -900, None), CAP)
    assert item["mate"] == 3 and item["color"] == "w" and item["reply"] == "Nxe5"


def test_mistake_candidates():
    p = ply_after("e4 e5 Qh5 Nc6 Bc4 Nf6", before=-20, after=-2000)
    assert is_mistake_candidate(D, p)
    assert not is_mistake_candidate(D, replace(p, before=-900))          # already lost
    assert not is_mistake_candidate(D, replace(p, before=900, after=700))  # still winning easily
    assert not is_mistake_candidate(D, replace(p, before=0, after=-50))    # too small


def test_item_id_is_stable_and_position_specific():
    a = item_id(chess.STARTING_FEN, chess.Move.from_uci("e2e4"))
    assert a == item_id(chess.STARTING_FEN, chess.Move.from_uci("e2e4"))
    assert a != item_id(chess.STARTING_FEN, chess.Move.from_uci("d2d4"))


class FakeEngine:
    """Every position evaluates to `cp` for White unless listed in `evals` by FEN."""
    def __init__(self, cp=0, evals=None):
        self.cp, self.evals, self.calls = cp, evals or {}, []

    def analyse(self, board, depth, multipv=1):
        self.calls.append((board.fen(), multipv))
        lines = self.evals.get(board.fen())
        if lines:
            return lines[:multipv]
        mv = next(iter(board.legal_moves), None)
        return [Line(mv.uci() if mv else None, self.cp, None)]


def test_walk_stops_when_my_move_ends_the_game():
    g = game_from("f3 e5 g4 Qh4#")            # fool's mate, I am Black and deliver it
    plies = list(walk(g, FakeEngine(), D.depth, CAP))
    assert [p.san for p in plies] == ["e5"]


def test_build_items_only_runs_multipv_on_candidates():
    g = game_from("e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#", result="1-0")
    before_nf6, after_nf6 = chess.Board(), chess.Board()
    for san in "e4 e5 Qh5 Nc6 Bc4".split():
        before_nf6.push_san(san)
    after_nf6 = before_nf6.copy()
    after_nf6.push_san("Nf6")
    eng = FakeEngine(evals={before_nf6.fen(): [Line("g7g6", 0, None)], after_nf6.fen(): [Line("h5f7", 10000, 1)]})
    items = build_items([g], eng, CFG)
    assert [(i["san"], i["better"], i["reply"]) for i in items] == [("Nf6", "g6", "Qxf7#")] and items[0]["result"] == "loss"
    assert [fen for fen, mpv in eng.calls if mpv > 1] == [before_nf6.fen()]


def test_read_games_detects_color_case_insensitively_and_skips_variants():
    pgn = ('[White "Dudacio"]\n[Black "x"]\n[Result "1-0"]\n\n1. e4 e5 1-0\n\n'
           '[White "x"]\n[Black "dudacio"]\n[Result "1-0"]\n\n1. d4 d5 1-0\n\n'
           '[White "x"]\n[Black "Dudacio"]\n[Variant "Chess960"]\n[Result "*"]\n\n1. e4 *\n\n')
    games = list(read_games(io.StringIO(pgn), "DUDACIO"))
    assert [(g.color, g.result) for g in games] == [(chess.WHITE, "win"), (chess.BLACK, "loss")]
    assert len(list(read_games(io.StringIO(pgn), "dudacio", chess.BLACK))) == 1


# --- real engine on known positions -----------------------------------------------------

needs_engine = pytest.mark.skipif(shutil.which(CFG.engine.path) is None and not shutil.which("stockfish", path="/opt/homebrew/bin:/usr/local/bin"), reason="Stockfish not found")


@pytest.fixture
def engine(tmp_path):
    with Engine(CFG.engine, tmp_path / "cache.sqlite") as e:
        yield e


@needs_engine
def test_engine_finds_scholars_mate_mistake(engine):
    g = game_from("e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#", result="1-0")
    items = build_items([g], engine, CFG)
    assert [(i["san"], i["reply"]) for i in items] == [("Nf6", "Qxf7#")]
    assert "Nf6" not in items[0]["accept_san"] and items[0]["better"] in items[0]["accept_san"]


@needs_engine
def test_engine_finds_hung_queen_as_white(engine):
    g = game_from("e4 e5 Qh5 Nc6 Qxe5+ Nxe5", color=chess.WHITE, result="0-1")
    items = build_items([g], engine, CFG)
    assert [(i["san"], i["reply"], i["color"]) for i in items] == [("Qxe5+", "Nxe5", "w")]
    assert items[0]["before_fen"].split()[1] == "w"


@needs_engine
def test_engine_cache_reuses_evaluations(engine):
    board = chess.Board()
    first = engine.analyse(board, 8, 3)
    assert engine.analyse(board, 8, 3) == first
    assert (engine.hits, engine.misses) == (1, 1)


@needs_engine
def test_engine_handles_game_over(engine):
    board = chess.Board()
    for san in "f3 e5 g4 Qh4#".split():
        board.push_san(san)
    [line] = engine.analyse(board, 8)
    assert line.move is None and line.pov(chess.BLACK) == CFG.engine.mate_score


def test_pawns_rounds_halves_away_from_zero():
    from cracktics.drills import pawns
    assert [pawns(v) for v in (25, 15, 45, -25, -24, 0, 1980, -2000)] == [0.3, 0.2, 0.5, -0.3, -0.2, 0.0, 19.8, -20.0]
