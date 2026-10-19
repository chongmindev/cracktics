"""Build the opening book for the Openings page from the Lichess open database (CC0, database.lichess.org).

Two steps, each resumable:
  count  stream one month of rated games (only as much of the file as needed), keep the ones in the rating and
         time range of [openings], and count every move sequence up to book_plies: games and results.
         Writes data/book/counts.json.
  eval   Stockfish (book_depth) on every position played at least book_min_games times, several engines at once.
         Checkpoints to data/book/evals.jsonl, then writes web/openings/book.json.

Usage: uv run --with zstandard python tools/build_book.py [count|eval|all] [--workers N] [--games N (a smoke test)]
       [--partial: write book.json from the evals so far, without running Stockfish]

book.json is one nested object per position: {"n": games, "r": [white wins, draws, black wins], "e": eval
(centipawns, White's view, mates folded to mate_score), "b": the engine's move (UCI), "o": [ECO, opening name]
when the position is a named opening, "k": {SAN: child, ...}} with children most played first.
"""
from __future__ import annotations

import io
import json
import re
import sys
import time
import subprocess
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import chess
import chess.engine

from cracktics import config

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / "data/book"
COUNTS = WORK / "counts.json"
EVALS = WORK / "evals.jsonl"
OUT = ROOT / "web/openings/book.json"
NAMES = ROOT / "web/src/openings.json"
URL = "https://database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst"
UA = "cracktics-book-builder (https://github.com/chongmindev/cracktics)"

COMMENT = re.compile(r"\{[^}]*\}")
NUMBER = re.compile(r"^\d+\.(\.\.)?$")
RESULTS = {"1-0": 0, "1/2-1/2": 1, "0-1": 2}
PRUNE_EVERY = 100_000   # games between prunes of sequences seen once (they can't reach book_min_games)


def games(stream, cfg):
    """Yield (result index, [SAN...]) for each game in range, from a PGN text stream."""
    head = {}
    for line in stream:
        if line.startswith("["):
            k, _, v = line[1:].partition(" ")
            head[k] = v.strip().rstrip("]").strip('"')
            continue
        if not line.strip() or not head:
            continue
        h, head = head, {}
        res = RESULTS.get(h.get("Result"))
        if res is None or "Rated" not in h.get("Event", ""):
            continue
        try:
            we, be = int(h.get("WhiteElo", 0)), int(h.get("BlackElo", 0))
            base = int(h.get("TimeControl", "-").split("+")[0])
        except ValueError:
            continue
        if not (cfg.book_min_elo <= we <= cfg.book_max_elo and cfg.book_min_elo <= be <= cfg.book_max_elo):
            continue
        if base < cfg.book_min_base:
            continue
        sans = []
        for tok in COMMENT.sub(" ", line).split():
            if NUMBER.match(tok) or tok in RESULTS or tok == "*":
                continue
            sans.append(tok.rstrip("!?"))
            if len(sans) >= cfg.book_plies:
                break
        if sans:
            yield res, sans


def count(cfg):
    import zstandard

    WORK.mkdir(parents=True, exist_ok=True)
    # curl streams the file (and stops when we stop reading): only the start of a 30 GB month is downloaded.
    curl = subprocess.Popen(["curl", "-sSfL", "-A", UA, URL.format(month=cfg.book_month)], stdout=subprocess.PIPE)
    tally: dict[str, list[int]] = {}
    n, t0 = 0, time.time()
    try:
        text = io.TextIOWrapper(zstandard.ZstdDecompressor().stream_reader(curl.stdout), encoding="utf-8", errors="replace")
        for res, sans in games(text, cfg):
            path = ""
            root = tally.setdefault("", [0, 0, 0, 0])
            root[0] += 1
            root[1 + res] += 1
            for san in sans:
                path = f"{path} {san}" if path else san
                t = tally.get(path)
                if t is None:
                    t = tally[path] = [0, 0, 0, 0]
                t[0] += 1
                t[1 + res] += 1
            n += 1
            if n % PRUNE_EVERY == 0:
                for k in [k for k, v in tally.items() if v[0] == 1]:
                    del tally[k]
                print(f"{n:,} games, {len(tally):,} sequences, {n / (time.time() - t0):,.0f} games/s", flush=True)
            if n >= cfg.book_games:
                break
    finally:
        curl.kill()
    kept = {k: v for k, v in tally.items() if v[0] >= cfg.book_min_games}
    COUNTS.write_text(json.dumps({"games": n, "month": cfg.book_month, "tally": kept}))
    print(f"counted {n:,} games; {len(kept):,} sequences with {cfg.book_min_games}+ games -> {COUNTS}")


def tree(tally):
    """Nested nodes from the flat tally, with each node's FEN; sequences whose parent was dropped are left out."""
    root = {"n": tally[""][0], "r": tally[""][1:], "k": {}, "fen": chess.STARTING_FEN}
    for path in sorted((p for p in tally if p), key=lambda p: p.count(" ")):
        *head, san = path.split(" ")
        node = root
        for s in head:
            node = node["k"].get(s)
            if node is None:
                break
        if node is None:
            continue
        b = chess.Board(node["fen"])
        try:
            b.push_san(san)
        except ValueError:
            continue
        node["k"][san] = {"n": tally[path][0], "r": tally[path][1:], "k": {}, "fen": b.fen()}
    return root


def key(fen):
    return " ".join(fen.split(" ")[:4])


_engine = None


def _init(path, threads, hash_mb):
    global _engine
    _engine = chess.engine.SimpleEngine.popen_uci(path)
    _engine.configure({"Threads": threads, "Hash": hash_mb})


def _eval(args):
    fen, depth, mate_score = args
    info = _engine.analyse(chess.Board(fen), chess.engine.Limit(depth=depth))
    score = info["score"].white()
    pv = info.get("pv") or []
    return key(fen), score.score(mate_score=mate_score), pv[0].uci() if pv else None


def evaluate(cfg, full, workers, partial=False):
    tally = json.loads(COUNTS.read_text())
    root = tree(tally["tally"])
    nodes, stack = [], [root]
    while stack:
        nd = stack.pop()
        nodes.append(nd)
        stack.extend(nd["k"].values())
    done = {}
    if EVALS.exists():
        for line in EVALS.read_text().splitlines():
            k, cp, best = json.loads(line)
            done[k] = (cp, best)
    todo = sorted({key(nd["fen"]): nd["fen"] for nd in nodes if key(nd["fen"]) not in done}.values())
    print(f"{len(nodes):,} book positions, {len(done):,} already evaluated, {len(todo):,} to go", flush=True)
    e = full.engine
    t0 = time.time()
    if partial:
        todo = []
    args = [(f, cfg.book_depth, e.mate_score) for f in todo]
    if workers <= 1 or len(todo) < 500:
        # A few positions (or one worker): this process, no pool. (The pool has stalled near the end of a long run.)
        _init(e.path, 1, 32)
        results, pool = map(_eval, args), None
    else:
        pool = ProcessPoolExecutor(workers, initializer=_init, initargs=(e.path, 1, 32))
        results = pool.map(_eval, args, chunksize=8)
    with EVALS.open("a") as out:
        for i, (k, cp, best) in enumerate(results):
            done[k] = (cp, best)
            out.write(json.dumps([k, cp, best]) + "\n")
            if (i + 1) % 1000 == 0:
                out.flush()
                print(f"{i + 1:,}/{len(todo):,} evaluated, {(i + 1) / (time.time() - t0):.1f}/s", flush=True)
    if pool:
        pool.shutdown()
    elif _engine:
        _engine.quit()

    names = json.loads(NAMES.read_text())   # position key -> [eco, name] (the Lichess opening list, CC0)

    def strip(nd):
        cp, best = done.get(key(nd["fen"]), (None, None))
        kids = sorted(nd["k"].items(), key=lambda kv: -kv[1]["n"])
        name = names.get(key(nd["fen"]))
        return {"n": nd["n"], "r": nd["r"], **({"e": cp} if cp is not None else {}), **({"b": best} if best else {}), **({"o": name} if name else {}),
                **({"k": {s: strip(c) for s, c in kids}} if kids else {})}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    book = {"_source": f"Lichess open database {tally['month']} (CC0): {tally['games']:,} rated games, "
                       f"both players {cfg.book_min_elo}-{cfg.book_max_elo}, {cfg.book_min_base}s base or more; "
                       f"positions with {cfg.book_min_games}+ games, Stockfish depth {cfg.book_depth}",
            "root": strip(root)}
    OUT.write_text(json.dumps(book, separators=(",", ":")))
    print(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB, {len(nodes):,} positions)")


if __name__ == "__main__":
    full = config.load()
    step = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else "all"
    workers = int(sys.argv[sys.argv.index("--workers") + 1]) if "--workers" in sys.argv else 4
    ocfg = full.openings
    if "--games" in sys.argv:
        from dataclasses import replace
        ocfg = replace(ocfg, book_games=int(sys.argv[sys.argv.index("--games") + 1]), book_min_games=3)
    if step in ("count", "all"):
        count(ocfg)
    if step in ("eval", "all"):
        evaluate(ocfg, full, workers, partial="--partial" in sys.argv)
