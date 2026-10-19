// Scout: what an opponent plays in the opening and where it goes badly for them, from their finished games.
// Pure functions over games in the shape chesscom.js / lichess.js return (seen from the opponent: `color` is the
// colour they had, `result` is their result). No engine here; scout-app.js adds the engine check of their habits.

import { Chess } from "chess.js";

/** A position without the move counters, so the same position reached by different move orders matches. */
export const keyOf = (fen) => fen.split(" ").slice(0, 4).join(" ");

/** Their score in a node: wins plus half the draws, over games. */
export const score = (n) => (n.n ? (n.w + n.d / 2) / n.n : 0);

/** The name of an opening's family: "Sicilian Defense: Najdorf Variation" -> "Sicilian Defense". */
export const family = (name) => name?.split(":")[0] ?? null;

function node(move, fen, ply, parent, names) {
  const key = keyOf(fen);
  return { san: move?.san ?? null, uci: move ? move.from + move.to + (move.promotion || "") : null, fen, key, ply, parent,
    name: names[key]?.[1] ?? parent?.name ?? null, eco: names[key]?.[0] ?? parent?.eco ?? null,
    n: 0, w: 0, d: 0, l: 0, kids: new Map(), links: [] };
}

function count(nd, g) {
  nd.n++;
  if (g.result === "win") nd.w++; else if (g.result === "draw") nd.d++; else nd.l++;
  if (g.link && nd.links.length < 5) nd.links.push(g.link);   // games come newest first, so these are the latest
}

/**
 * The opening tree of their games, first `plies` plies. names: position key -> [eco, name] (src/openings.json).
 * Returns {root, games, book, openings}: book = per game, the last ply still in a named opening; openings = per game,
 * {name, eco, result} of the deepest named position it reached.
 */
export function buildTree(games, { plies = 24, names = {} } = {}) {
  const root = node(null, new Chess().fen(), 0, null, names);
  const book = [], openings = [];
  for (const g of games) {
    const chess = new Chess();
    let cur = root, last = 0, named = null;
    count(cur, g);
    for (let i = 0; i < Math.min(plies, g.moves.length); i++) {
      let m;
      try { m = chess.move(g.moves[i]); } catch { break; }
      let kid = cur.kids.get(m.san);
      if (!kid) cur.kids.set(m.san, (kid = node(m, chess.fen(), i + 1, cur, names)));
      cur = kid;
      count(cur, g);
      if (names[cur.key]) { last = i + 1; named = names[cur.key]; }
    }
    book.push(last);
    if (named) openings.push({ eco: named[0], name: named[1], result: g.result });
  }
  return { root, games: games.length, book, openings };
}

/** Children of a node, most played first. */
export const kidsOf = (nd) => [...nd.kids.values()].sort((a, b) => b.n - a.n || score(a) - score(b));

/** Every node below `root`, depth first. */
export function* walk(root) {
  for (const k of root.kids.values()) { yield k; yield* walk(k); }
}

/** The moves from the start to a node, as SAN. */
export function lineOf(nd) {
  const out = [];
  for (let x = nd; x?.san; x = x.parent) out.unshift(x.san);
  return out;
}

/** "1.e4 c5 2.Nf3" for a list of SAN moves from the start. */
export function numberLine(sans) {
  return sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}.${s}` : s)).join(" ");
}

/** Is `nd` on the same path as `other` (one is the other's ancestor)? */
function related(nd, other) {
  for (let x = nd; x; x = x.parent) if (x === other) return true;
  for (let x = other; x; x = x.parent) if (x === nd) return true;
  return false;
}

/**
 * Lines you can steer into where they do badly: positions reached by YOUR move (their turn next) with at least
 * minGames of their games and a score at least `gap` below their overall score. Ranked by how far below, weighted by
 * the square root of the games (a 3-game blip counts less than a 12-game pattern). Lines on the same path as a
 * better-ranked one are skipped, so the list isn't the same line at five depths.
 */
export function weakSpots(tree, theirColor, { minGames = 3, gap = 0.12, max = 6 } = {}) {
  const overall = score(tree.root);
  const cands = [];
  for (const nd of walk(tree.root)) {
    if (nd.n < minGames || nd.fen.split(" ")[1] !== theirColor) continue;
    const below = overall - score(nd);
    if (below >= gap) cands.push({ node: nd, below, rank: below * Math.sqrt(nd.n) });
  }
  cands.sort((a, b) => b.rank - a.rank);
  const out = [];
  for (const c of cands) {
    if (out.length >= max) break;
    if (!out.some((o) => related(o.node, c.node))) out.push(c);
  }
  return out;
}

/**
 * Their games grouped by opening family (the deepest named position each game reached), most played first.
 * Returns [{family, eco, n, w, d, l, score}], families with at least minGames.
 */
export function byFamily(tree, { minGames = 3 } = {}) {
  const fam = new Map();
  for (const o of tree.openings) {
    const f = family(o.name), e = fam.get(f) || { family: f, eco: o.eco, n: 0, w: 0, d: 0, l: 0 };
    e.n++;
    if (o.result === "win") e.w++; else if (o.result === "draw") e.d++; else e.l++;
    fam.set(f, e);
  }
  return [...fam.values()].filter((e) => e.n >= minGames).map((e) => ({ ...e, score: score(e) })).sort((a, b) => b.n - a.n);
}

/**
 * Their habits: positions where it's their move, reached at least minGames times, where they play the same move in
 * at least minShare of those games. Most reached first. [{node, move (the child node), share}]
 */
export function habits(tree, theirColor, { minGames = 3, minShare = 0.5 } = {}) {
  const out = [];
  for (const nd of [tree.root, ...walk(tree.root)]) {
    if (nd.n < minGames || nd.fen.split(" ")[1] !== theirColor || !nd.kids.size) continue;
    const [top] = kidsOf(nd);
    const share = top.n / nd.n;
    if (share >= minShare) out.push({ node: nd, move: top, share });
  }
  return out.sort((a, b) => b.node.n - a.node.n || a.node.ply - b.node.ply);
}

/** Their usual line from the start: the most played move at each step while at least `min` games follow it. */
export function mainLine(tree, min = 2) {
  const out = [];
  for (let nd = tree.root; ;) {
    const [top] = kidsOf(nd);
    if (!top || top.n < min) return out;
    out.push(top);
    nd = top;
  }
}

/** How predictable they are: over their own moves in the first `plies`, the share that was their usual move there. */
export function predictability(tree, theirColor, plies = 12) {
  let same = 0, all = 0;
  for (const nd of [tree.root, ...walk(tree.root)]) {
    if (nd.ply >= plies || nd.fen.split(" ")[1] !== theirColor || !nd.kids.size) continue;
    const kids = kidsOf(nd), total = kids.reduce((s, k) => s + k.n, 0);
    same += kids[0].n;
    all += total;
  }
  return all ? same / all : 0;
}

/** On average, the move number where their games leave the named openings. */
export function bookExit(tree) {
  const b = tree.book.filter((x) => x > 0);
  return b.length ? Math.round(b.reduce((s, x) => s + x, 0) / b.length / 2 + 0.5) : null;
}


/**
 * The road to a node: each move from the start, whose it was, and for their moves the share of their games at that
 * point that went this way. odds: the product of those shares, the chance they follow the road when you play your
 * moves on it (from their games, so a guide, not a promise).
 */
export function road(nd, theirColor) {
  const steps = [];
  let odds = 1;
  for (let x = nd; x?.parent; x = x.parent) {
    const theirs = x.parent.fen.split(" ")[1] === theirColor, share = x.n / x.parent.n;
    if (theirs) odds *= share;
    steps.unshift({ node: x, theirs, share });
  }
  return { steps, odds };
}

/** Game plans, best first: their costly habits ranked by the chance they walk into one times what it costs (capped). */
export function rankPlans(slips, theirColor, { lossCap = 500 } = {}) {
  return slips.map((s) => ({ ...s, ...road(s.move, theirColor) }))
    .map((p) => ({ ...p, value: p.odds * Math.min(p.loss, lossCap) }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Their moves worth checking with the engine: moves they made (their turn) at least minGames times in the tree,
 * most played first, at most `max`. Each is a child node; its parent is the position they played it from.
 */
export function theirMoves(tree, theirColor, { minGames = 2, max = 60 } = {}) {
  const out = [];
  for (const nd of walk(tree.root)) if (nd.n >= minGames && nd.parent.fen.split(" ")[1] === theirColor) out.push(nd);
  return out.sort((a, b) => b.n - a.n || a.ply - b.ply).slice(0, max);
}

/** A move's verdict from what it gives away (centipawns against the best move): best, good, dubious, mistake, blunder. */
export function verdictOf(loss, { best = false, dubious = 50, mistake = 100, blunder = 250 } = {}) {
  if (best) return "best";
  return loss >= blunder ? "blunder" : loss >= mistake ? "mistake" : loss >= dubious ? "dubious" : "good";
}
