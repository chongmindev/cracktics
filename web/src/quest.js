// The Openings quest, as pure functions over the book (web/openings/book.json, built by tools/build_book.py).
//
// A book node is {n: games, r: [white wins, draws, black wins], e: eval (centipawns, White's view), b: engine move
// (UCI), o: [ECO, name], k: {SAN: child}} with children most played first. A path is the list of SANs from the start.
//
// The quest for an opening and a side: from the start, the opening's own moves are played (you play yours); after
// that, at each of your turns you find a good move, and at each of theirs they play one of the moves worth learning
// to answer (see `candidates`). Your repertoire move at each position is the most played move that is within
// answer_tolerance of the best (`repertoire`); the quest follows it, so the lines form a tree whose leaves are where
// the book runs out. Progress is which leaves you have finished.

import { Chess } from "chess.js";

export const kidsOf = (nd) => Object.entries(nd?.k || {}).map(([san, node]) => ({ san, node }));
export const share = (kid, parent) => (parent.n ? kid.n / parent.n : 0);
export const at = (book, path) => path.reduce((nd, san) => nd?.k?.[san], book);
export const pathKey = (path) => path.join(" ");
export const turnOf = (path) => (path.length % 2 ? "b" : "w");

/** What `color`'s move from `parent` to `child` gives away against the best, in centipawns (0 or more). */
export function lossOf(parent, child, color) {
  if (parent.e == null || child.e == null) return 0;
  return Math.max(0, (color === "w" ? 1 : -1) * (parent.e - child.e));
}

/** Score of `color` in the book's games through `nd`, 0..1. */
export function scoreOf(nd, color) {
  const [w, d, l] = nd.r || [0, 0, 0], n = w + d + l;
  return n ? ((color === "w" ? w : l) + d / 2) / n : 0;
}

/** The engine's move at a node, as SAN from the position at `path`, or null. */
export function engineSan(nd, path) {
  if (!nd?.b) return null;
  try {
    const g = fenAt(path, true);
    return g.move({ from: nd.b.slice(0, 2), to: nd.b.slice(2, 4), promotion: nd.b[4] }).san;
  } catch { return null; }
}

/** The position after `path` (a FEN, or the Chess game when `game`). */
export function fenAt(path, game = false) {
  const g = new Chess();
  for (const san of path) g.move(san);
  return game ? g : g.fen();
}

/**
 * Your move at `nd` when it's your turn (`me`): the most played book move within answer_tolerance of the best.
 * Returns {san, node, loss} or, if no book move is good enough, the engine's move {san, node: child or null}.
 */
export function repertoire(nd, me, path, cfg) {
  const good = kidsOf(nd).map((k) => ({ ...k, loss: lossOf(nd, k.node, me) })).filter((k) => k.loss <= cfg.answer_tolerance);
  if (good.length) return good[0];
  const san = engineSan(nd, path);
  return san ? { san, node: nd.k?.[san] || null, loss: 0 } : null;
}

/**
 * Their moves worth learning to answer at `nd` (their turn; `them` is their colour), each with why:
 *   common  the most played moves, down to side_min_share, at most side_max (rank 1 = most played)
 *   best    the engine's favourite among the book moves
 *   slip    a move people play often (side_min_share) that gives away trap_reply_loss or more: punish it
 *   trap    a rarer move (trap_min_share) that costs them little, where the most played answer to it is a mistake
 * Returns [{san, node, share, loss, kinds: [...], rank}] most played first.
 */
export function candidates(nd, them, cfg) {
  const me = them === "w" ? "b" : "w";
  const kids = kidsOf(nd).map((k, i) => ({ ...k, rank: i + 1, share: share(k.node, nd), loss: lossOf(nd, k.node, them), kinds: [] }));
  kids.filter((k) => k.share >= cfg.side_min_share).slice(0, cfg.side_max).forEach((k) => k.kinds.push("common"));
  const fair = kids.filter((k) => k.share >= cfg.trap_min_share);
  const best = fair.reduce((a, k) => (!a || k.loss < a.loss ? k : a), null);
  if (best) best.kinds.push("best");
  for (const k of kids) {
    if (k.share >= cfg.side_min_share && k.loss >= cfg.trap_reply_loss) k.kinds.push("slip");
    if (k.share < cfg.trap_min_share || k.loss > cfg.trap_max_loss) continue;
    const answer = kidsOf(k.node)[0];
    if (answer && lossOf(k.node, answer.node, me) >= cfg.trap_reply_loss) { k.kinds.push("trap"); k.trap = answer.san; }
  }
  return kids.filter((k) => k.kinds.length);
}

/**
 * The quest tree: from `entry` (the opening's moves), your repertoire move at your turns and every candidate at
 * theirs, until the book runs out or `maxPlies`. Returns {leaves: [path], count: {trap, slip, common, best}}:
 * each leaf is one line to finish; count tallies their moves in the tree by kind.
 */
export function questTree(book, entry, me, cfg, maxPlies = 24) {
  const leaves = [], count = { common: 0, best: 0, slip: 0, trap: 0 };
  const walk = (nd, path) => {
    if (!nd || path.length >= maxPlies) return leaves.push(path);
    if (turnOf(path) === me) {
      const r = repertoire(nd, me, path, cfg);
      if (!r || !r.node || !kidsOf(r.node).length) return leaves.push(r ? [...path, r.san] : path);
      return walk(r.node, [...path, r.san]);
    }
    const cs = candidates(nd, turnOf(path), cfg);
    if (!cs.length) return leaves.push(path);
    for (const c of cs) {
      for (const kind of c.kinds) count[kind]++;
      walk(c.node, [...path, c.san]);
    }
  };
  const start = at(book, entry);
  if (start) walk(start, [...entry]);
  return { leaves, count };
}

/**
 * Openings to pick from: each family (the name before ":") at its first and most played position in the book, with
 * the side that chose it (who made the last move into it). Most played first.
 */
export function families(book) {
  const best = new Map();
  const walk = (nd, path) => {
    if (nd.o) {
      const [eco, name] = nd.o, fam = name.split(":")[0];
      const cur = best.get(fam);
      if (!cur || path.length < cur.path.length || (path.length === cur.path.length && nd.n > cur.n))
        best.set(fam, { name: fam, eco, path, n: nd.n, side: path.length % 2 ? "w" : "b" });
    }
    for (const { san, node } of kidsOf(nd)) walk(node, [...path, san]);
  };
  walk(book, []);
  return [...best.values()].filter((f) => f.path.length).sort((a, b) => b.n - a.n);
}

/** The opening name at `path`: the deepest named position on the way. */
export function nameAt(book, path) {
  let nd = book, name = book.o || null;
  for (const san of path) {
    nd = nd?.k?.[san];
    if (!nd) break;
    if (nd.o) name = nd.o;
  }
  return name;
}

/**
 * Which of their candidates to play next. Lines you haven't finished come first, weighted by how many unfinished
 * leaves lie behind each move; once all are done, the move whose line you answered worst (lowest box), then the one
 * seen longest ago. `done`: leaf key -> true; `boxes`: leaf key -> 1..5; `seen`: leaf key -> turn last finished.
 */
export function chooseMove(cands, path, leaves, { done = {}, boxes = {}, seen = {} } = {}, rand = Math.random) {
  const under = (c) => leaves.filter((l) => l.length > path.length && l[path.length] === c.san &&
    path.every((s, i) => l[i] === s));
  const open = cands.map((c) => ({ c, w: under(c).filter((l) => !done[pathKey(l)]).length })).filter((x) => x.w > 0);
  if (open.length) {
    let r = rand() * open.reduce((a, x) => a + x.w, 0);
    for (const x of open) if ((r -= x.w) < 0) return x.c;
    return open.at(-1).c;
  }
  const worst = (c) => Math.min(...under(c).map((l) => boxes[pathKey(l)] || 0), 9);
  const oldest = (c) => Math.min(...under(c).map((l) => seen[pathKey(l)] ?? -1), Infinity);
  return [...cands].sort((a, b) => worst(a) - worst(b) || oldest(a) - oldest(b))[0] || null;
}

/** "the most played move (61%)", "the 4th most played (6%)": how to say a candidate's popularity. */
export function rankText(c) {
  const pct = c.share >= 0.995 ? "99%" : c.share >= 0.01 ? `${Math.round(100 * c.share)}%` : "under 1%";
  if (c.rank === 1) return `the most played move (${pct})`;
  const nth = c.rank === 2 ? "2nd" : c.rank === 3 ? "3rd" : `${c.rank}th`;
  return `the ${nth} most played (${pct})`;
}
