# Cracktics — project handoff

Read this first. It explains what already exists, what we learned, and what to build next.

## The idea

A chess trainer that drills the *defensive* scan: "after my move, what can my opponent do to me?"
Existing tools (Chess.com Retry Mistakes, Lichess Learn from your mistakes, Aimchess) train finding
*your own* winning tactic. Almost nothing trains spotting the opponent's reply, which is the main
reason I lose.

The project has two parts:
1. **Backend (MCP server + engine pipeline):** pulls my finished Chess.com games, runs Stockfish,
   and extracts drill positions.
2. **Front end (trainer):** shows the position just before one of my mistakes and asks me to find the
   move I missed. Uses spaced repetition. (Until 2026-10-19 it asked for the opponent's punishing reply
   after my move, or "nothing works"; see docs/decisions.md.)

## What exists

```
cracktics/          # package: config, engine (SQLite eval cache), games, report, drills, page, cli
config.toml          # every depth and threshold
tests/               # selection rules on fake evals + known positions on the real engine
trainer/
  trainer_template.html     # single-file trainer, __ITEMS__ placeholder (either color)
data/                       # gitignored: PGNs, engine cache, reports, items
```

Rebuild (Stockfish on PATH, or `export STOCKFISH=/path`):
```
uv sync
uv run cracktics fetch Dudacio data/games.pgn [--months 2] [--time-class rapid|blitz|bullet|daily|all]
uv run cracktics report data/<games>.pgn data/analysis.json --user Dudacio
uv run cracktics drills data/<games>.pgn data/items.json --user Dudacio [--color white|black|both]
uv run cracktics page data/items.json trainer/trainer_template.html trainer/cracktics-drill.html
uv run pytest
uv run cracktics-mcp   # MCP server over stdio
```
Engine evals are cached by (FEN, depth, MultiPV) in `data/engine_cache.sqlite`, so reruns are fast.
Item ids are a hash of FEN + move, so trainer progress survives rebuilds.

### How positions are chosen
- **Mistake item:** move 3+, my move lost >= 1 pawn at depth 13, I wasn't already lost (eval before > -3)
  and wasn't still winning easily after it (eval after < +5). Accepted answers = my moves from MultiPV 5
  (before my move) within 0.5 pawns of the best that also beat my move by 0.75; any other move is judged by
  the engine with the same two tests.
- Item fields: `id`, `color` (my side), `before_fen` (the puzzle, me to move), `fen` (after my move), `from`/`to`
  (my move), `san`, `move`, `opp`, `date`, `result` (win/loss/draw for me), `kind` ("mistake"), plus `accept`,
  `accept_san`, `better`, `reply` (their best answer to my move), `mate` (mine, if the best line mates), `swing`,
  `evb`, `eva`.

### Trainer behavior
- Board oriented with my side at the bottom, Unicode pieces via Noto Sans Symbols 2, chess.js 0.10.3 for
  legal moves.
- "Hint" marks the piece the best move moves (and counts as a miss).
- Leitner boxes 1–5, stored in localStorage (per browser only).

## What I learned from the 50 games (context for priorities)
- 20W / 3D / 27L, average ~73 centipawn loss per move, rating ~870–956.
- Losses: 15 had a hung piece, 12 walked into mate, 9 were thrown from +3 or better, 2 on time.
- Big blunders by phase: opening 20, middlegame (moves 13–30) 62, endgame 26.
- Openings: strong vs. the e4-e5 advance (7-0-1), weak vs. 1.d4 (3-0-8), 0-5 when I didn't open
  1...d5. Plan to switch to a QGD setup vs. 1.d4.
- One session on Oct 6 had 5 straight losses (tilt idea for later).

## What to build next (in order)

1. ~~Clean up the pipeline into a package~~ (done 2026-10-14).
2. ~~Chess.com fetch~~ (done 2026-10-14): monthly archives only, serial requests 1 s apart, past months
   cached in `data/chesscom_cache/`, rapid only by default (`[fetch]` in config.toml).
3. ~~MCP server~~ (done 2026-10-15): `uv run cracktics-mcp` (stdio; `.mcp.json` registers it for Claude Code
   in this folder). Engine tools run as background jobs on one worker thread and return progress until done;
   a job is keyed by the exact set of games, so new games start a new job. Originally specified as:
   - `fetch_games(username, months)` — finished games only
   - `analyze_games(username, months, color)` — engine report (like analysis.json)
   - `get_drill_positions(username, ...)` — items.json shape
   - `summary(username)` — hung pieces, mates allowed, blunders by phase, results by opening
4. **Trainer reads from the backend** instead of a baked-in JSON, so new games refresh the deck.
5. Later: tilt detector (clock times are in the API PGNs as `[%clk]`), repertoire drift checker.

## Hard rules
- **Fair play:** only ever analyze *finished* games. Never expose the current/live games endpoint
  to the engine. Chess.com bans engine assistance during games.
- Engine work is slow (50 games ≈ a few minutes at depth 13–14). Only run MultiPV on candidate
  positions; cache by FEN.
- Guard game-over positions (no PV after mate).
