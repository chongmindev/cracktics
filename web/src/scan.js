// The scan: analyse games newest first, several at once, and grow the deck as each game finishes.
// Games already analysed (with the same rules) are read from the store, so a return visit only
// analyses new games.

import { gameCandidates, screenedCandidates } from "./rules.js";

export function gameKey(game) {
  return game.link || `${game.date} ${game.opponent} ${game.moves.length}`;
}

/** A fingerprint of the drill rules: change a threshold and old candidates are recomputed. */
export function rulesVersion(cfg) {
  return JSON.stringify({ items: ITEM_SCHEMA, drills: cfg.drills });
}

/** Bump when items gain or change fields, so cached candidates are rebuilt (2: before_fen; 3: mistakes). */
const ITEM_SCHEMA = 3;

/**
 * Two phases, both newest game first:
 *   1. quick: screenedCandidates on every game not yet analysed, so most of the deck appears fast;
 *   2. deep: gameCandidates on every game, reusing all cached evals, which completes the exact deck.
 * Each game's result is stored with its phase, so a return visit resumes where the last one stopped.
 */
export class Scan {
  /** onUpdate({deck, phase, done, total, running, failed, stats}) fires after every game. */
  constructor({ username, games, evaluator, store, cfg, concurrency = 1, onUpdate = () => {} }) {
    Object.assign(this, { username, games, evaluator, store, cfg, concurrency, onUpdate });
    this.prefix = `${username.toLowerCase()}|${rulesVersion(cfg)}|`;
    this.byGame = new Map();     // gameKey -> {phase, items}
    this.failed = [];
    this.stopped = false;
    this.phase = 1;
  }

  deck() {
    return [...this.byGame.values()].flatMap((c) => c.items || []);
  }

  /** done and total count all games, so a resumed scan reads "game 10 of 107", not "game 1 of 98". */
  _emit(running) {
    let done = this.failed.length;
    for (const c of this.byGame.values()) if (c.phase >= this.phase) done++;
    this.onUpdate({ deck: this.deck(), phase: this.phase, done: Math.min(done, this.games.length), total: this.games.length,
                    running, failed: this.failed.length, stats: this.evaluator.stats });
  }

  async _pass(games, phase, analyseGame) {
    this.phase = phase;
    const pending = [...games];
    this._emit(pending.length > 0);
    const worker = async () => {
      while (pending.length && !this.stopped) {
        const g = pending.shift();
        const key = gameKey(g);
        try {
          const c = { phase, items: await analyseGame(g, this.evaluator.forGame(), this.cfg) };
          await this.store.putCandidates(this.prefix + key, c);
          this.byGame.set(key, c);
        } catch (e) {
          // One bad game must not stop the scan. It isn't stored, so it is retried next visit.
          console.error(`cracktics: skipped game ${key}`, e);
          this.failed.push(key);
        }
        this._emit(pending.length > 0);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, this.concurrency) }, worker));
  }

  async run() {
    for (const g of this.games) {
      const c = await this.store.getCandidates(this.prefix + gameKey(g));
      if (c) this.byGame.set(gameKey(g), c);
    }
    const unseen = this.games.filter((g) => !this.byGame.has(gameKey(g)));
    await this._pass(unseen, 1, screenedCandidates);
    const shallow = this.games.filter((g) => this.byGame.get(gameKey(g))?.phase !== 2);
    if (!this.stopped) await this._pass(shallow, 2, gameCandidates);
    this.phase = 2;
    this._emit(false);
    return this.deck();
  }

  stop() {
    this.stopped = true;
  }
}
