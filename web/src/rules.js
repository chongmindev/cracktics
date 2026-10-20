// Drill selection, ported from cracktics/drills.py. Must stay in step with it: the parity test
// (web/test/parity.test.js) runs both on the same recorded evals and requires identical items.
//
// An eval Line is {move: uci|null, cp: int (White's view, mates folded in), mate: int|null (White's view)}.
// `analyse(fen, depth, multipv)` is any async function returning Lines, best first.

import { Chess } from "chess.js";

export const WHITE = "w";
export const BLACK = "b";

const clamp = (v, cap) => Math.max(-cap, Math.min(cap, v));
const pov = (line, color) => (color === WHITE ? line.cp : -line.cp);
const other = (color) => (color === WHITE ? BLACK : WHITE);

export function uciOf(m) {
  return m.from + m.to + (m.promotion || "");
}

function moveOf(chess, uci) {
  return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
}

/** SAN of a UCI move in `fen` (python-chess and chess.js agree on SAN, checked by the parity test). */
export function sanOf(fen, uci) {
  return moveOf(new Chess(fen), uci).san;
}

/** python-chess Board.is_game_over() without claims: mate, stalemate, insufficient material,
 *  the 75-move rule and fivefold repetition. (chess.js's isGameOver also ends on threefold and 50 moves.) */
export function isGameOver(chess, seen) {
  if (chess.isCheckmate() || chess.isStalemate() || chess.isInsufficientMaterial()) return true;
  if (Number(chess.fen().split(" ")[4]) >= 150) return true;
  return seen ? (seen.get(positionKey(chess.fen())) || 0) >= 5 : false;
}

/** Position identity for repetition: placement, side, castling, en passant. */
export function positionKey(fen) {
  return fen.split(" ").slice(0, 4).join(" ");
}

async function sha1hex(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Stable across rebuilds (same as Python item_id). */
export async function itemId(fen, uci) {
  return (await sha1hex(`${fen} ${uci}`)).slice(0, 12);
}

/** Centipawns to pawns at one decimal, halves away from zero (same as Python pawns). */
export function pawns(cp) {
  const tenths = Math.floor((Math.abs(cp) + 5) / 10);
  return (cp >= 0 ? tenths : -tenths) / 10 + 0; // + 0 turns -0 into 0, as Python's integer math does
}

/**
 * My moves in one game, each with clamped evals before and after. Stops if my move ends the game.
 * game = {color, moves: [{from, to, promotion?}], opponent, date, result, link?}
 */
export async function* walk(game, analyse, depth, cap) {
  const chess = new Chess();
  const seen = new Map([[positionKey(chess.fen()), 1]]);
  let line = (await analyse(chess.fen(), depth, 1))[0];
  let prev = null;   // the move just before (theirs, when it's my turn): {fen before it, from, to, promotion, san}
  for (let i = 0; i < game.moves.length; i++) {
    const mine = chess.turn() === game.color;
    const fenBefore = chess.fen();
    const before = clamp(pov(line, game.color), cap);
    const bestSan = mine && line.move ? sanOf(fenBefore, line.move) : null;
    const m = moveOf(chess, uciOf(game.moves[i]));
    const prevMove = prev;
    prev = { fen: fenBefore, from: m.from, to: m.to, ...(m.promotion ? { promotion: m.promotion } : {}), san: m.san };
    const key = positionKey(chess.fen());
    seen.set(key, (seen.get(key) || 0) + 1);
    if (mine && isGameOver(chess, seen)) return;
    line = (await analyse(chess.fen(), depth, 1))[0];
    if (mine) {
      yield { game, moveNumber: Math.floor(i / 2) + 1, fenBefore, fen: chess.fen(), move: m, uci: uciOf(m),
              san: m.san, bestSan, prevMove, before, after: clamp(pov(line, game.color), cap) };
    }
  }
}

const loss = (p) => Math.max(0, p.before - p.after);

/** A mistake worth a puzzle: it cost a lot, I wasn't already lost, and I wasn't still winning easily after it. */
export function isMistakeCandidate(c, p) {
  return p.moveNumber >= c.mistake_min_move && p.before > c.mistake_min_before && p.after < c.mistake_max_after &&
    loss(p) >= c.mistake_min_loss;
}

async function base(p) {
  const g = p.game;
  return { id: await itemId(p.fen, p.uci), fen: p.fen, before_fen: p.fenBefore, color: g.color, from: p.move.from, to: p.move.to,
           san: p.san, move: p.moveNumber, opp: g.opponent, date: g.date, result: g.result,
           evb: pawns(p.before), eva: pawns(p.after), ...(g.link ? { link: g.link } : {}),
           ...(p.prevMove ? { prev_fen: p.prevMove.fen, prev: { from: p.prevMove.from, to: p.prevMove.to, san: p.prevMove.san,
             ...(p.prevMove.promotion ? { promotion: p.prevMove.promotion } : {}) } } : {}) };
}

/**
 * The puzzle: the position before my mistake; find a move as good as the engine's. `lines` is MultiPV for me
 * before my move; `reply` is the opponent's best answer to the move I played. Accepted: moves within
 * accept_within of the best that also beat my move by accept_min_gain. Null when none qualifies.
 */
export async function mistakeItem(c, p, lines, reply, cap) {
  const me = p.game.color;
  lines = lines.filter((l) => l.move);
  if (!lines.length) return null;
  const top = lines[0], mine = (l) => clamp(pov(l, me), cap);
  const accept = lines.filter((l) => l.move !== p.uci && mine(l) >= mine(top) - c.accept_within && mine(l) >= p.after + c.accept_min_gain);
  if (!accept.length || accept[0] !== top) return null;
  const mate = top.mate === null || top.mate === undefined ? null : me === WHITE ? top.mate : -top.mate;
  return { ...(await base(p)), kind: "mistake", accept: accept.map((l) => l.move),
           accept_san: accept.map((l) => sanOf(p.fenBefore, l.move)), better: sanOf(p.fenBefore, top.move),
           reply: reply?.move ? sanOf(p.fen, reply.move) : null, mate: mate > 0 ? mate : null, swing: pawns(loss(p)) };
}

/** Run the drill rule on one of my moves (evals at full depth). Returns an item or null. */
async function classify(p, analyse, cfg) {
  const c = cfg.drills, cap = cfg.engine.eval_cap;
  if (!isMistakeCandidate(c, p)) return null;
  const lines = await analyse(p.fenBefore, c.depth, c.multipv);
  const [reply] = await analyse(p.fen, c.depth, 1);
  return mistakeItem(c, p, lines, reply, cap);
}

/** Puzzle items from one game. Every position at full depth. */
export async function gameCandidates(game, analyse, cfg) {
  const items = [];
  for await (const p of walk(game, analyse, cfg.drills.depth, cfg.engine.eval_cap)) {
    const it = await classify(p, analyse, cfg);
    if (it) items.push(it);
  }
  return items;
}

/**
 * The quick pass: screen every position at scan.screen_depth, then apply the full-depth rule only to my
 * moves within scan.screen_margin of its thresholds. Those moves get the same deep evals as gameCandidates,
 * so every item found here is identical to the full pass's; it just may miss a few.
 */
export async function screenedCandidates(game, analyse, cfg) {
  const c = cfg.drills, cap = cfg.engine.eval_cap, { screen_depth: depth, screen_margin: margin } = cfg.scan;
  const picks = [];
  for await (const p of walk(game, analyse, depth, cap)) {
    if (p.moveNumber >= c.mistake_min_move && p.before > c.mistake_min_before - margin &&
        p.after < c.mistake_max_after + margin && loss(p) >= c.mistake_min_loss - margin) picks.push(p);
  }
  const items = [];
  for (const p of picks) {
    const lineBefore = (await analyse(p.fenBefore, c.depth, 1))[0];
    const lineAfter = (await analyse(p.fen, c.depth, 1))[0];
    const deep = { ...p, before: clamp(pov(lineBefore, p.game.color), cap), after: clamp(pov(lineAfter, p.game.color), cap),
                   bestSan: lineBefore.move ? sanOf(p.fenBefore, lineBefore.move) : null };
    const it = await classify(deep, analyse, cfg);
    if (it) items.push(it);
  }
  return items;
}

export async function buildItems(games, analyse, cfg) {
  const items = [];
  for (const g of games) items.push(...await gameCandidates(g, analyse, cfg));
  return items;
}
