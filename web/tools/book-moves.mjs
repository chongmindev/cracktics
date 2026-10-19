// Builds openings/moves.json: a verdict for every legal move at every position where you're to move in some quest
// (every opening, both sides, and "every opening at once"), keyed by position. The page judges your move from it
// alone, so the same move in the same position always gets the same verdict, at once. Without it a move the book
// doesn't have was judged by the Lichess cloud or the browser's Stockfish, whichever answered, against the book's
// own eval: sources that disagree near the line, so a move could be wrong one time and right the next.
//
// Measured the way the book measures its own moves (quest.js lossOf): the position's book eval minus the eval after
// the move, from the mover's side, both at book_depth. Book moves reuse the book's evals; the rest are searched here.
// Resumable: positions already in the output are skipped, and progress is saved as it goes.
// Usage: node tools/book-moves.mjs [--engine /path/to/stockfish] [--workers 7]
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { Chess } from "chess.js";
import { at, families, posKey, questTree, turnOf } from "../src/quest.js";
import { UciEngine } from "../src/uci.js";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ENGINE = arg("engine", process.env.STOCKFISH || "stockfish");
const WORKERS = +arg("workers", Math.max(1, availableParallelism() - 1));
const OUT = new URL("../openings/moves.json", import.meta.url);
const LOSS_CAP = 2000;   // past this a move is lost either way; keeps mate scores from dominating the file

const cfg = JSON.parse(readFileSync(new URL("../src/config.json", import.meta.url), "utf8"));
const O = cfg.openings;
const book = JSON.parse(readFileSync(new URL("../openings/book.json", import.meta.url), "utf8")).root;

// Every position where you're to move in any quest the page offers, after the opening's own moves.
const fams = families(book).filter((f) => f.n >= book.n * 0.0005);
const quests = [{ path: [], side: "w" }, { path: [], side: "b" }, ...fams.flatMap((f) => [{ path: f.path, side: "w" }, { path: f.path, side: "b" }])];
const todo = new Map();   // posKey -> {fen, e: book eval (White's view) or null, kids: book children by SAN}
for (const qst of quests) {
  const { leaves } = questTree(book, qst.path, qst.side, O, O.book_plies);
  for (const leaf of leaves) {
    for (let i = qst.path.length; i < leaf.length; i++) {
      const path = leaf.slice(0, i);
      if (turnOf(path) !== qst.side) continue;
      const g = new Chess();
      for (const san of path) g.move(san);
      const key = posKey(g.fen());
      if (todo.has(key)) continue;
      const nd = at(book, path);
      todo.set(key, { fen: g.fen(), e: nd?.e ?? null, kids: nd?.k || {} });
    }
  }
}

const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { pos: {} };
out._source = `Stockfish depth ${O.book_depth} after every legal move at each quest position; loss in centipawns from the mover's side`;
out.depth = O.book_depth;
const queue = [...todo].filter(([key]) => !out.pos[key]);
console.log(`${todo.size} positions, ${queue.length} to analyse, ${WORKERS} engines (${ENGINE})`);

function save() {
  const tmp = new URL("../openings/moves.json.tmp", import.meta.url);
  writeFileSync(tmp, JSON.stringify(out));
  renameSync(tmp, OUT);
}

function processTransport(path) {
  const p = spawn(path, [], { stdio: ["pipe", "pipe", "inherit"] });
  let cb = () => {}, buf = "";
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (line) cb(line); }
  });
  return { send: (l) => p.stdin.write(l + "\n"), onLine: (f) => (cb = f), kill: () => p.kill() };
}

/** {san: loss} for a move within tolerance, {san: [loss, reply]} otherwise (the reply explains a miss). */
async function verdicts(engine, { fen, e, kids }) {
  const g = new Chess(fen), sign = g.turn() === "w" ? 1 : -1;
  const before = e ?? (await engine.analyse(fen, O.book_depth, 1))[0].cp;
  const res = {};
  for (const m of g.moves({ verbose: true })) {
    const kid = kids[m.san];
    let after, reply;
    if (kid?.e != null) [after, reply] = [kid.e, kid.b || null];
    else {
      const [line] = await engine.analyse(m.after, O.book_depth, 1);
      [after, reply] = [line.cp, line.move];
    }
    const loss = Math.min(LOSS_CAP, Math.max(0, Math.round(sign * (before - after))));
    res[m.san] = loss <= O.answer_tolerance || !reply ? loss : [loss, reply];
  }
  return res;
}

let done = 0, lastSave = Date.now();
const t0 = Date.now();
const engines = await Promise.all(Array.from({ length: WORKERS }, async () => {
  const t = processTransport(ENGINE);
  const e = await new UciEngine(t, { mateScore: cfg.engine.mate_score }).init({ Threads: 1, Hash: 64 });
  e.kill = t.kill;
  return e;
}));
await Promise.all(engines.map(async (engine) => {
  for (let item; (item = queue.shift()); ) {
    out.pos[posKey(item[1].fen)] = await verdicts(engine, item[1]);
    done++;
    if (Date.now() - lastSave > 30_000) {
      lastSave = Date.now();
      save();
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`${done} done, ${queue.length} left, ~${Math.round(queue.length / rate / 60)} min to go`);
    }
  }
}));
save();
for (const e of engines) { e.quit(); e.kill(); }
console.log(`wrote openings/moves.json: ${Object.keys(out.pos).length} positions in ${Math.round((Date.now() - t0) / 1000)}s`);
