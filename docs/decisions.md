# Decisions

Each entry: what was chosen, what was rejected, and the evidence. Newest first.

## 2026-10-15 · Lichess cloud evals are off by default

Benchmarked a 30-game scan in Node with 7 lite engines (`web/bench/scan.mjs`):

| | first item | quick pass done | full deck |
|---|---|---|---|
| cloud off | 8.2 s | 83 s | 123 s |
| cloud on | 7.9 s | 108 s | 172 s |

The cloud answered 8 of 11 requests, but its serial queue (one request at a time, by Lichess's rules)
stalls engines that could search the same position locally in 8–47 ms. The code stays; pass a
`LichessCloud` to `Evaluator` to enable it, which may help on devices with one or two cores.

## 2026-10-15 · Two-phase scan: quick screened pass, then a deep pass

Measured on the 107 reference games against the single-pass lite deck (`tools/measure_twopass.py`):

| screen depth | margin | threats found | deep positions needed |
|---|---|---|---|
| 6 | 100 | 90.8% | 30% |
| 8 | 100 | 94.1% | 30% |
| **10** | **100** | **97.4%** | **29%** |
| 10 | 200 | 98.0% | 43% |

Lite search costs 2 / 4 / 8 / 47 ms per position at depth 6 / 8 / 10 / 13. Chosen: screen at depth 10,
margin 100 cp, then a deep pass over every game that reuses the cache. The quick pass shows about 97% of
the deck in under half the engine time; the deep pass ends with exactly the single-pass deck, so nothing
is lost. Rejected: shipping the screened deck alone (2–3% of threats missed even at a 200 cp margin).

## 2026-10-15 · Lite vs. full Stockfish: what the 79% means

Lite (browser) vs. native full, both depth 13, on 107 games: full 170 threats, lite 152, both 134
(recall 79%, precision 88%). On all 134 shared threats lite's reply is one full accepts. The
disagreements sit at the thresholds: swings near 2.5 pawns, "before" evals near −3, and perpetual
checks full sees and lite doesn't at depth 13.

Noise baseline: the same full engine with 1 thread instead of 4 agrees on only 149 of 170 threats
(recall 88%, precision 90%), and its replies are always accepted too. So about 12 points of
disagreement are engine noise at these thresholds, and lite costs about 9 more. Accepted: it is free,
runs on the visitor's machine, and never disagrees about the punishing reply itself.

## 2026-10-15 · Chess.com games are parsed from TCN, not PGN

Chess.com archive entries carry `tcn`, two characters per move. Decoding it is arithmetic only.
- Measured: chess.js `loadPgn` + `history()` costs 112 ms per game (12 s for 107 games, blocking the
  page); replaying SAN with `move()` is worse (2 ms per move). TCN decoding: 0.12 ms per game.
- Checked: TCN moves equal chess.js PGN moves on every standard game of a real 98-game archive,
  including promotions and castling (`web/test/games.test.js`). PGN stays as the fallback when `tcn` is
  missing or malformed.

## 2026-10-15 · Lichess cloud castling is converted to standard UCI

Lichess cloud evals write castling as king-takes-rook (`e1h1`); chess.js and Stockfish use `e1g1`.
Found in the first browser run (it crashed the scan). `standardCastling()` converts only when the moving
piece is a king. A failing game is now skipped and retried next visit instead of stopping the scan.

## 2026-10-15 · Lichess cloud: early positions only, stop at a game's first miss

- Measured on 10 recent games: cloud evals cover the first 12–17 plies, then stop (one short game was
  covered to the end). Its depth is ~50, far above our 13.
- So each game asks the cloud until its first miss, then never again (one wasted request per game).
  A cached cloud eval answers any request at the same or lower depth.
- Requests are serial (Lichess API rule) and back off for 60 s after HTTP 429.
- Consequence: early-game evals are deeper than the rest, so the browser's deck can differ slightly from
  the Python deck on opening blunders. Parity tests run without the cloud.

## 2026-10-15 · Browser engine: one single-threaded lite Stockfish per core

Benchmarked depth 13 on 24 middlegame positions and 12 blunder positions (MultiPV 1 and 5):

| Build | s/position (MultiPV 1) | MultiPV 5 on blunders |
|---|---|---|
| native full, 4 threads | 0.138 | – |
| native full, 1 thread | 0.085 | 0.31 |
| wasm lite, 1 thread | 0.062 | 0.29 |
| wasm lite, 4 threads | 0.070 | – |

- At a fixed depth, threads search more nodes (118k vs. 31k per position), not finish sooner. The
  multi-threaded wasm build also had pathological slowdowns in sharp positions (5.6 s on one position).
- Chosen: a pool of single-threaded lite engines, `hardwareConcurrency - 1` (max 8), one game each.
  No cross-origin isolation headers needed, so any static host and any browser works.
- Rejected: full-strength wasm (99 MB download, over the per-file limit of free static hosts);
  multi-threaded lite (slower here, needs COOP/COEP).
- Pending: whether lite picks the same drills as the native full engine (`tools/measure_lite.py`).

## 2026-10-15 · Safe items are sampled by a per-position hash, not a random stream

The prototype sampled safe moves with `random.Random(3)`, so the choice depended on game order. The
browser scans newest first and adds games over time, which would reshuffle the safe items and orphan
progress. Now `sample_key(seed, fen, move)` (SHA-1) decides both the sample and the cap order, in Python
and JS alike. Adding a game never changes which earlier safe items were chosen unless the cap binds.

## 2026-10-15 · Pawn values and the safe cap are rounded with integer arithmetic

Python's `round()` is half-to-even on inexact floats, which JS can't reproduce simply. `pawns(cp)` rounds
centipawns to tenths, halves away from zero, using integers; the safe cap is `floor(n * ratio + 0.5)`.
Identical in both languages.

## 2026-10-19 · The drill is the position before my mistake; find the better move

The drill used to show the board right after one of my moves and ask for the opponent's punishing reply (or
"nothing works" for a safe move), then ask for the fix. Chong asked for something simpler and more useful: go back
to before the mistake and find the best move. Now an item is a move that cost at least `mistake_min_loss` (1 pawn)
while I wasn't already lost (`mistake_min_before`) or still winning easily (`mistake_max_after`). Accepted answers
are the MultiPV moves within `accept_within` of the best that beat my move by `accept_min_gain`; any other move is
judged by the engine against the same two tests. Python (`cracktics/drills.py`) and JS (`web/src/rules.js`) changed
together, so the parity test still holds. The quick pass's `screen_margin` dropped from 100 to 50: at 100 the screen
(loss ≥ 0) would let every move through. Rejected: keeping safe positions as a share of the deck (they belonged to
the "is there a threat?" question, which this drill no longer asks).

## 2026-10-19 · The Openings book is built from the Lichess open database, not the opening explorer

The Lichess opening explorer (explorer.lichess.ovh) now answers 401 without a login, and an OAuth login would
leave out everyone without a Lichess account. Instead `tools/build_book.py` streams the start of one month of the
open database (CC0; curl stops after the games it needs, about 2 GB of a 30 GB file), keeps rated blitz-or-slower
games between 1200 and 2300, counts every move sequence to ply 24, keeps positions with 40+ games, and evaluates
each with Stockfish at depth 16. The book ships with the site, so the quest needs no network and no waiting. Moves
are counted by sequence, not by position, so transpositions are separate lines.

