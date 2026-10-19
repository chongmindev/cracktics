# Cracktics

Most chess trainers drill finding *your own* winning tactic. This one drills the other half of a blunder
check: **after my move, what can my opponent do to me?**

It reads your finished Chess.com games, runs Stockfish over them, and builds a deck of positions taken
right after one of your moves:

- **Threat positions:** your move lost 2.5+ pawns to a check or capture. Find the punishing reply.
- **Safe positions:** your move was fine. Recognise that nothing works, without over-worrying.

The trainer shows each position from your side of the board, takes your answer as a move on the board,
and schedules positions with spaced repetition (Leitner boxes).

> The web app runs entirely in the browser, for anyone with a Chess.com or Lichess username:
> **https://chongmindev.github.io/cracktics/** (source in [`web/`](web/)). The Python pipeline, MCP server
> and single-file trainer below read Chess.com only.

## Scout

A second page, **https://chongmindev.github.io/cracktics/scout/**, prepares you for a game against one person.
Give it their username (and, if they have one, their account on the other site, pooled into one report) and
the colour you'll have; it reads their finished games and shows:

- **Game plan:** moves they've made at least twice that give something away (Stockfish checks their 60 most
  played), as full lines, best bets first (how likely they walk into it, times
  what it costs): your moves to get there, how often they follow, where they can go another way, their habit, and
  Stockfish's punishment, stepped on the board a move at a time with a line on what each move does.
- **Weak spots:** lines you can steer into where they score well below their usual, and their results by opening.
- **Explorer:** their opening tree from the start: what they play at each move, how often, how often they won
  after it, and Stockfish's verdict on it (best, good, dubious, mistake, blunder, with what it gives away),
  with named openings (the Lichess opening list, CC0) and links to their latest games in that line.
- **Habits:** positions they reach often and answer the same way, each checked with Stockfish; a habit that
  gives something away is marked.

Recent games count more: a game loses half its weight every 60 days before their newest game
(`half_life_days`), in every percentage; game counts stay real counts. The thresholds live in `[scout]` in `config.toml`; the analysis is `web/src/scout.js`.

## Requirements

- [uv](https://docs.astral.sh/uv/) (Python 3.12+)
- [Stockfish](https://stockfishchess.org/) on your `PATH` (`brew install stockfish`), or set `STOCKFISH=/path/to/stockfish`

```
uv sync
```

## Usage

```
# 1. Finished games from the Chess.com archives (rapid, last two monthly archives by default)
uv run cracktics fetch <username> data/games.pgn [--months 2] [--time-class rapid|blitz|bullet|daily|all]

# 2. Drill positions (both colors by default)
uv run cracktics drills data/games.pgn data/items.json --user <username> [--color white|black|both]

# 3. Bake them into the trainer, then open it in a browser
uv run cracktics page data/items.json trainer/trainer_template.html trainer/cracktics-drill.html
open trainer/cracktics-drill.html

# Optional: per-game engine report (centipawn loss, hung pieces, missed and allowed mates)
uv run cracktics report data/games.pgn data/analysis.json --user <username>
```

The first run is slow: Stockfish evaluates every position in every game (about 30 minutes for 100 rapid
games on a laptop). Every evaluation is cached in `data/engine_cache.sqlite`, so reruns and new games are
fast.

## MCP server

The same pipeline is exposed as an MCP server, so you can ask Claude about your games
("why do I lose as Black?", "give me my drill positions from September").

| Tool | Returns |
|---|---|
| `fetch_games` | your finished games: date, color, opponent, result, link |
| `analyze_games` | per-game engine report |
| `get_drill_positions` | the trainer's deck |
| `summary` | record by color, why games were lost, big blunders by phase, results by opening |

Engine tools run as background jobs: the first call starts the work and returns progress, and calling
again with the same arguments returns the result once it is done.

- **Claude Code:** `.mcp.json` in this folder registers the server automatically.
- **Other clients:** run `uv run --directory /path/to/this/repo cracktics-mcp` over stdio.

## Configuration

Every depth and threshold lives in [`config.toml`](config.toml): engine settings, what counts as a threat
or a safe move, which replies are accepted, phase boundaries for the summary, and the Chess.com fetch
settings (request pacing, time classes).

## Fair play

Only **finished** games are ever analysed. The fetcher reads Chess.com's monthly archives, which contain
finished games only, and never calls the current-games endpoints. On Lichess the web app uses the games
export with `ongoing=false`, which returns finished games only. Both sites ban engine assistance during
games; this tool is for reviewing them afterwards. Scout studies an opponent's finished public games
before you play them, which both sites allow; it is not for use during a game.

## Privacy

Your games, engine cache, reports and built trainer stay in `data/` and `trainer/cracktics-drill.html`,
which are gitignored.

## Development

```
uv run pytest
```

Tests cover the selection rules on fake engine output, known blunders on the real engine (skipped if
Stockfish is missing), the Chess.com fetcher with a fake HTTP layer, and the MCP tools end to end.

Project notes and the roadmap are in [`HANDOFF.md`](HANDOFF.md).

## Licence

GPL-3.0-or-later (see [`LICENSE`](LICENSE)). The Python side uses python-chess and the web app ships
Stockfish.js, both GPLv3. The web app also ships chess.js (BSD-2-Clause) and the cburnett pieces
(GPLv2+); their notices are copied into the built site.
