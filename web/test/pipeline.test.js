import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Chess } from "chess.js";
import { ChessCom } from "../src/chesscom.js";
import { EnginePool, Evaluator, fromEntries, LichessCloud } from "../src/evals.js";
import { buildItems, gameCandidates, screenedCandidates } from "../src/rules.js";
import { Scan } from "../src/scan.js";
import { MemoryStore } from "../src/store.js";

const cfg = JSON.parse(readFileSync(new URL("../src/config.json", import.meta.url), "utf8"));
const START = new Chess().fen();
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

class FakeEngine {
  constructor(lines = (fen) => [{ move: new Chess(fen).moves({ verbose: true })[0]?.lan ?? null, cp: 0, mate: null }]) {
    this.lines = lines;
    this.calls = [];
  }
  async analyse(fen, depth, multipv) { this.calls.push([fen, depth, multipv]); return this.lines(fen).slice(0, multipv); }
}

test("fromEntries reuses deeper evals and needs enough lines", () => {
  const e = [{ depth: 50, multipv: 1, lines: [{ move: "e2e4", cp: 20, mate: null }] }];
  assert.deepEqual(fromEntries(e, 13, 1), e[0].lines);
  assert.equal(fromEntries(e, 13, 5), null);
  assert.equal(fromEntries(e, 60, 1), null);
  assert.deepEqual(fromEntries([{ ...e[0], complete: true }], 13, 5), e[0].lines);
});

test("Lichess cloud: converts mates, backs off on 429, one request at a time", async () => {
  let inFlight = 0, maxInFlight = 0;
  const responses = [
    json({ depth: 40, pvs: [{ moves: "e2e4 e7e5", cp: 18 }, { moves: "d2d4", mate: 3 }] }),
    json({ error: "rate limited" }, 429),
  ];
  const cloud = new LichessCloud({ minInterval: 0, fetch: async () => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return responses.shift();
  } });
  const [a, b, c] = await Promise.all([cloud.get(START, 2), cloud.get(START, 2), cloud.get(START, 2)]);
  assert.deepEqual(a.lines, [{ move: "e2e4", cp: 18, mate: null }, { move: "d2d4", cp: 9997, mate: 3 }]);
  assert.equal(b, null);
  assert.equal(c, null, "paused for a minute after 429, no request sent");
  assert.equal(cloud.requests, 2);
  assert.equal(maxInFlight, 1);
});

test("Evaluator: cache, then cloud until the game's first miss, then engine", async () => {
  const store = new MemoryStore();
  const known = new Set([START]);
  const cloud = { calls: 0, async get(fen) { this.calls++; return known.has(fen) ? { depth: 45, lines: [{ move: "e2e4", cp: 20, mate: null }], complete: false } : null; } };
  const engine = new FakeEngine();
  const ev = new Evaluator({ store, cloud, pool: new EnginePool([engine]) });
  const analyse = ev.forGame();
  const c = new Chess();
  assert.equal((await analyse(c.fen(), 13, 1))[0].cp, 20);          // cloud
  c.move("e4");
  await analyse(c.fen(), 13, 1);                                     // cloud miss -> engine
  known.add(c.fen());                                                // even if it were known later...
  c.move("e5");
  await analyse(c.fen(), 13, 1);                                     // ...the cloud is closed for this game
  assert.equal(cloud.calls, 2);
  assert.equal(engine.calls.length, 2);
  assert.equal((await ev.forGame()(START, 13, 1))[0].cp, 20);       // cached
  assert.deepEqual(ev.stats, { cache: 1, cloud: 1, engine: 2 });
});

test("EnginePool spreads concurrent searches over idle engines", async () => {
  const busy = new Set();
  let overlap = false;
  const mk = (name) => ({ async analyse() { if (busy.has(name)) overlap = true; busy.add(name); await new Promise((r) => setTimeout(r, 5)); busy.delete(name); return [name]; } });
  const pool = new EnginePool([mk("a"), mk("b")]);
  const got = await Promise.all([1, 2, 3, 4].map(() => pool.analyse(START, 1, 1)));
  assert.equal(overlap, false);
  assert.deepEqual(new Set(got.flat()), new Set(["a", "b"]));
});

const PGN = (white, black, result, link, moves) =>
  `[Event "Live Chess"]\n[White "${white}"]\n[Black "${black}"]\n[Result "${result}"]\n[Date "2026.10.01"]\n[Link "${link}"]\n\n${moves} ${result}`;

function fakeChessCom(store) {
  const base = "https://api.chess.com/pub/player/me/games";
  const pages = {
    [`${base}/archives`]: { archives: [`${base}/2026/08`, `${base}/2026/09`, `${base}/2026/10`] },
    [`${base}/2026/09`]: { games: [{ rules: "chess", time_class: "rapid", end_time: 1, pgn: PGN("them", "me", "1-0", "g1", "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7#") }] },
    [`${base}/2026/10`]: { games: [
      { rules: "chess", time_class: "rapid", end_time: 3, pgn: PGN("me", "them", "1-0", "g3", "1. d4 d5 2. c4") },
      { rules: "chess", time_class: "bullet", end_time: 2, pgn: PGN("me", "them", "1-0", "g2", "1. d4 d5") },
      { rules: "chess960", time_class: "rapid", end_time: 4, pgn: "" }] },
  };
  const calls = [];
  const cc = new ChessCom({ store, minInterval: 0, now: () => new Date("2026-10-15T00:00:00Z"),
    fetch: async (url) => { calls.push(url); return pages[url] ? json(pages[url]) : json({}, 404); } });
  return { cc, calls };
}

test("ChessCom: newest first, filters, caches past months, never touches current-games endpoints", async () => {
  const store = new MemoryStore();
  const { cc, calls } = fakeChessCom(store);
  const games = await cc.games("Me", { months: 2 });
  assert.deepEqual(games.map((g) => g.link), ["g3", "g1"]);
  calls.length = 0;
  await cc.games("me", { months: 2 });
  assert.deepEqual(calls.map((u) => u.split("/games")[1]), ["/archives", "/2026/10"]);
  assert.ok(calls.every((u) => !/\/games$|\/to-move$/.test(u)));
});

test("Scan grows the deck per game and reuses analysed games on the next visit", async () => {
  const store = new MemoryStore();
  const { cc } = fakeChessCom(store);
  const games = await cc.games("me", { months: 2 });
  const blunder = (() => { const c = new Chess(); for (const m of ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6"]) c.move(m); return c.fen(); })();
  const engine = new FakeEngine((fen) => fen === blunder ? [{ move: "h5f7", cp: 9999, mate: 1 }] : new FakeEngine().lines(fen));
  const updates = [];
  const scan = new Scan({ username: "me", games, store, cfg, evaluator: new Evaluator({ store, pool: new EnginePool([engine]) }),
    onUpdate: (u) => updates.push([u.done, u.deck.length]) });
  const deck = await scan.run();
  assert.deepEqual(deck.map((i) => [i.san, i.reply, i.link]), [["Nf6", "Qxf7#", "g1"]]);
  assert.deepEqual(updates.at(-1), [2, 1]);

  const before = engine.calls.length;
  const again = await new Scan({ username: "me", games, store, cfg, evaluator: new Evaluator({ store, pool: new EnginePool([engine]) }) }).run();
  assert.deepEqual(again, deck);
  assert.equal(engine.calls.length, before, "no engine work on a return visit");
});

test("Lichess castling (king takes rook) becomes standard UCI", async () => {
  const fen = "r3k2r/pppq1ppp/2npbn2/2b1p3/2B1P3/2NPBN2/PPPQ1PPP/R3K2R w KQkq - 6 8";
  const cloud = new LichessCloud({ minInterval: 0, fetch: async () => json({ depth: 30, pvs: [{ moves: "e1h1 e8a8", cp: 10 }, { moves: "e1a1", cp: 5 }] }) });
  const { lines } = await cloud.get(fen, 2);
  assert.deepEqual(lines.map((l) => l.move), ["e1g1", "e1c1"]);
  const rookMove = await new LichessCloud({ minInterval: 0, fetch: async () => json({ depth: 30, pvs: [{ moves: "h1g1", cp: 1 }] }) }).get(fen, 1);
  assert.equal(rookMove.lines[0].move, "h1g1");
});

test("Scan skips a game that fails and keeps going", async () => {
  const store = new MemoryStore();
  const { cc } = fakeChessCom(store);
  const games = await cc.games("me", { months: 2 });
  let calls = 0;
  const pool = new EnginePool([{ async analyse(fen) { if (++calls === 1) throw new Error("boom"); return new FakeEngine().lines(fen); } }]);
  const updates = [];
  const orig = console.error; console.error = () => {};
  try {
    await new Scan({ username: "me", games, store, cfg, evaluator: new Evaluator({ store, pool }), onUpdate: (u) => updates.push(u) }).run();
  } finally { console.error = orig; }
  assert.equal(updates.at(-1).done, 2);
  assert.equal(updates.at(-1).failed, 1);
});


// Shallow searches (depth < drills.depth) see nothing; the deep search sees the blunder.
function depthAwareEngine(blunderFen) {
  const base = new FakeEngine();
  return { calls: [], async analyse(fen, depth, multipv) {
    this.calls.push([fen, depth, multipv]);
    if (fen === blunderFen && depth >= cfg.drills.depth) return [{ move: "h5f7", cp: 9999, mate: 1 }];
    return base.lines(fen).slice(0, multipv);
  } };
}

test("quick pass items are identical to the full pass's; the deep pass finds what the screen missed", async () => {
  const c = new Chess();
  for (const m of ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6"]) c.move(m);
  const store = new MemoryStore();
  const { cc } = fakeChessCom(store);
  const games = await cc.games("me", { months: 2 });
  const blunderGame = games.find((g) => g.link === "g1");

  // A screen that sees the blunder (same evals at every depth) finds the same item as the full pass.
  const eng = new FakeEngine((fen) => fen === c.fen() ? [{ move: "h5f7", cp: 9999, mate: 1 }] : new FakeEngine().lines(fen));
  const analyse = (f, d, m) => eng.analyse(f, d, m);
  assert.deepEqual(await screenedCandidates(blunderGame, analyse, cfg), await gameCandidates(blunderGame, analyse, cfg));

  // A screen that is blind to it misses it; the two-phase Scan still ends with the exact full deck.
  const blind = depthAwareEngine(c.fen());
  const quick = await screenedCandidates(blunderGame, (f, d, m) => blind.analyse(f, d, m), cfg);
  assert.equal(quick.length, 0);
  const phases = [];
  const deck = await new Scan({ username: "me", games, store, cfg, evaluator: new Evaluator({ store, pool: new EnginePool([depthAwareEngine(c.fen())]) }),
    onUpdate: (u) => phases.push([u.phase, u.deck.length]) }).run();
  const full = await buildItems(games, (f, d, m) => depthAwareEngine(c.fen()).analyse(f, d, m), cfg);
  assert.deepEqual(deck, full);
  assert.deepEqual(deck.map((i) => i.reply), ["Qxf7#"]);
  assert.ok(phases.some(([p, n]) => p === 1 && n === 0) && phases.at(-1)[0] === 2, JSON.stringify(phases));
});

test("ChessCom ranges: newest N games, last N days, all time", async () => {
  const base = "https://api.chess.com/pub/player/me/games";
  const g = (n, t) => ({ rules: "chess", time_class: "rapid", end_time: t, pgn: PGN("me", "them", "1-0", `g${n}`, "1. d4 d5") });
  const day = 86400, now = Date.UTC(2026, 9, 15) / 1000;
  const pages = {
    [`${base}/archives`]: { archives: [`${base}/2026/07`, `${base}/2026/09`, `${base}/2026/10`] },
    [`${base}/2026/07`]: { games: [g(1, now - 90 * day)] },
    [`${base}/2026/09`]: { games: [g(2, now - 30 * day), g(3, now - 20 * day)] },
    [`${base}/2026/10`]: { games: [g(5, now - 2 * day), g(4, now - 10 * day)] },
  };
  const calls = [];
  const cc = new ChessCom({ store: new MemoryStore(), minInterval: 0, now: () => new Date(now * 1000),
    fetch: async (url) => { calls.push(url); return json(pages[url]); } });
  const links = (gs) => gs.map((x) => x.link);
  assert.deepEqual(links(await cc.games("me", { range: { games: 3 } })), ["g5", "g4", "g3"]);
  assert.ok(!calls.includes(`${base}/2026/07`), "stops reading once it has enough games");
  assert.deepEqual(links(await cc.games("me", { range: { days: 14 } })), ["g5", "g4"]);
  assert.deepEqual(links(await cc.games("me", { range: { days: 25 } })), ["g5", "g4", "g3"]);
  assert.deepEqual(links(await cc.games("me", { range: { all: true } })), ["g5", "g4", "g3", "g2", "g1"]);
  assert.deepEqual(links(await cc.games("me", { months: 1 })), ["g5", "g4"]);
});
