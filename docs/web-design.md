# Cracktics for anyone: in-browser design

Status: being built (2026-10-15). Measurements and choices are in `docs/decisions.md`.

## Goal

Anyone types a Chess.com username and drills the defensive scan on positions from their own finished
games. Free to host, nothing to install, no server. The first visit should be drillable within about a
minute; later visits only analyse new games.

## Constraints

- **Free.** Static files on Cloudflare Pages (free plan, private repo OK). No backend, no paid API.
- **Fair play.** Only finished games from the Chess.com monthly archives. Never the current-games
  endpoints, and no analysis of a game in progress.
- **Chess.com only** for now. The fetch layer is one module so Lichess games can be added later.
- **Privacy.** The username goes only to Chess.com. Positions (not usernames) go to the Lichess
  cloud-eval API. Everything else stays in the visitor's browser.

## Verified facts (2026-10-15)

- `api.chess.com` sends `Access-Control-Allow-Origin: *`, so the browser can fetch archives directly.
- `lichess.org/api/cloud-eval?fen=…&multiPv=N` sends CORS headers; known positions return depth ~50+
  lines, unknown positions return 404.
- `stockfish@19.0.0` on npm (GPLv3) ships: full multi-threaded (99 MB wasm), full single (99 MB),
  **lite multi-threaded (1.6 MB)**, **lite single (1.8 MB)**, and an asm.js fallback.
  Multi-threaded builds need cross-origin isolation (COOP `same-origin` + COEP `require-corp`).

## Architecture

```
page (UI) ── username ─► fetch worker ── Chess.com archives (cached per month in IndexedDB)
   ▲                         │ games, newest first
   │ items as found          ▼
   └──────────────── scan scheduler ── eval sources, in order:
                                         1. IndexedDB eval cache (per device)
                                         2. opening book (static JSON shipped with the site)
                                         3. Lichess cloud eval (rate-limited, polite)
                                         4. engine pool (N lite Stockfish workers)
```

### Engine pool
- Lite single-threaded build, one engine per core (`hardwareConcurrency - 1`, max 8), each on its own
  game. Measured faster than the multi-threaded build at a fixed depth, and it needs no cross-origin
  isolation, so no special headers.
- Whether lite picks the same drills as the native full engine is measured by `tools/measure_lite.py`.

### Two-pass scan (the main speed lever)
1. **Screen** every position at a shallow depth (cheap).
2. **Confirm** only candidates at full depth: moves whose shallow loss is near a threat threshold, and the
   sampled safe candidates, plus MultiPV on those.
The screen depth and the margin around thresholds are chosen by measurement: the two-pass result must find
the same items as the single-pass Python pipeline on the reference games (target: ≥ 95% of threat items,
no false threats). Recorded in `docs/decisions.md`.

### Progressive results
- Games are processed newest first. Items appear in the deck as soon as they are confirmed.
- The UI shows a progress bar (games scanned, positions evaluated, items found) and stays usable.
- Scanning can be paused and resumes after a reload from the cached evals.

### Opening book
- Built offline on the Mac by a Python script: evals for positions reached in the first ~10 moves of
  common openings, at the drill depth, from Lichess cloud evals where present, else local Stockfish.
- Shipped as a compressed static file. Size budget: a few MB.

### Storage (IndexedDB)
- `evals` keyed by (FEN, depth, MultiPV), same shape as the Python SQLite cache.
- `archives` per username and month (past months are final).
- `items` per username; `progress` (Leitner boxes) keyed by stable item id (same hash as Python).
- Progress is saved automatically in each browser (IndexedDB). The export/import links were removed (2026-10-20): moving between browsers or devices needs sync, not built.

## Parity with the Python pipeline

- The selection rules (threat, safe, accepted replies) are ported to one JS module with no DOM
  dependencies, driven by the same `config.toml` values (exported to JSON at build time).
- Parity tests run the JS rules (Node) on the Python pipeline's recorded evals for the reference games
  and must produce identical items.
- Reference games: the 107 rapid games already in `data/` (local only, never committed); tests refer to
  them by game link and ply, never by content.

## Trainer

- The existing trainer UI, reading items from IndexedDB instead of a baked-in list.
- Adds: "View this game on Chess.com" link (move-anchored), deck filters (color, threat/safe, date),
  and a per-session summary.
- Later: a summary page (record, why losses happened, blunders by phase, results by opening) from the
  same scan.

## Hosting

- Cloudflare Pages, static build from the repo, `*.pages.dev` address.
- Engine files served from the same origin; `_headers` only sets caching and basic security headers.
- GPLv3 notice and a link to the stockfish.js source in the footer.

## Open questions

- Lite vs. full net agreement on what counts as a threat (measure first).
- Screen depth and candidate margin for the two-pass scan (measure first).
- Lichess cloud-eval politeness: request pacing and what to do on HTTP 429.
- Whether the full net is ever worth offering as an opt-in download.
