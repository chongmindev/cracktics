// Openings page: pick an opening and a side, then play every line of it from move one. At your turns you find a good
// move (the book's evals judge it; Stockfish judges a move the book doesn't have); at theirs, they play one of the
// moves worth learning to answer: the most played, sidelines, the engine's favourite, common mistakes and rare traps
// (src/quest.js). Lines you haven't finished come first; then the ones you answered worst.

import { Chess } from "chess.js";
import { Board } from "./board.js";
import { EnginePool, Evaluator, LichessCloud } from "./evals.js";
import { at, candidates, chooseMove, families, kidsOf, lossOf, nameAt, pathKey, questTree, rankText, repertoire, turnOf } from "./quest.js";
import { Select } from "./select.js";
import { sound } from "./sound.js";
import { IdbStore, MemoryStore } from "./store.js";
import { UciEngine } from "./uci.js";
import { fitHero, poolSize, setupTheme, workerTransport } from "./ui.js";

const cfg = await (await fetch(new URL("./config.json", import.meta.url))).json();
const O = cfg.openings;
const ENGINE_URL = "engine/stockfish-19-lite-single.js";
const COLOR = { w: "White", b: "Black" };
const THEIR_PAUSE = 450;   // ms before their move, so yours is seen first
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pawns = (cp) => (cp / 100).toFixed(1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ALL = "__all__";   // the opening select's "every opening, from move one"

let book = null, fams = [], store = null, board = null, evaluate = null;
let q = null;   // the quest: {fam, me, entry, leaves, count, prog, key, path, game, sel, marks, misses, firstTry, busy, phase, last}

async function openStore() {
  try { return await IdbStore.open(); } catch { return new MemoryStore(); }
}

const sideNow = () => document.querySelector("input[name=side]:checked")?.value || "w";

/** "1.e4 d5 2.exd5" for a path. */
function numbered(path) {
  return path.map((san, i) => (i % 2 ? san : `${i / 2 + 1}.${san}`)).join(" ");
}

/** A move as it reads in a line: "2.exd5", then just "Qxd5" for Black's reply. */
const moveText = (i, san) => (i % 2 ? san : `${i / 2 + 1}.${san}`);

function setStatus(text) {
  $("status").hidden = !text;
  $("status-text").textContent = text || "";
}

/** Stockfish for moves the book doesn't have: the Lichess cloud first, then engines in this browser. */
async function engine() {
  if (evaluate) return evaluate;
  const engines = await Promise.all(Array.from({ length: Math.min(2, poolSize()) }, () =>
    new UciEngine(workerTransport(ENGINE_URL), { mateScore: cfg.engine.mate_score }).init({ Hash: 16 })));
  const ev = new Evaluator({ store, pool: new EnginePool(engines), cloud: new LichessCloud({ mateScore: cfg.engine.mate_score }) });
  evaluate = async (fen) => (await ev.forGame()(fen, O.book_depth, 1))[0];
  return evaluate;
}

// ---------- progress ----------

const freshProg = () => ({ done: {}, boxes: {}, seen: {}, turn: 0, traps: {}, stats: { answered: 0, ok: 0, streak: 0 } });

async function saveProg() { await store.set(q.key, q.prog); }

// ---------- the quest ----------

async function startQuest(famName, me) {
  const fam = famName === ALL ? { name: "Whole repertoire", path: [], side: me } : fams.find((f) => f.name === famName);
  if (!fam) return;
  const entry = fam.path;
  const { leaves, count } = questTree(book, entry, me, O, O.book_plies);
  const key = `quest|${fam.name}|${me}`;
  q = { fam, me, entry, leaves, count, key, prog: (await store.get(key)) || freshProg() };
  await store.set("openings-last", { opening: famName, side: me });
  board.white = me === "w";
  $("who").textContent = `${fam.name} as ${COLOR[me]} · ${leaves.length} line${leaves.length === 1 ? "" : "s"}`;
  $("start").classList.remove("open");
  document.body.dataset.view = "report";
  $("report").hidden = false;
  engine().catch(() => {});   // warm up for moves the book doesn't have
  newLine();
}

function newLine() {
  Object.assign(q, { path: [], game: new Chess(), sel: null, marks: {}, misses: 0, firstTry: null, busy: false, phase: "play", last: null, log: [] });
  $("q-done").innerHTML = "";
  $("btn-next").hidden = true;
  paintStats();
  step();
}

/** Whose turn, and what happens next: their move, your move, or the end of the line. */
async function step() {
  const nd = at(book, q.path);
  if (!nd || q.path.length >= O.book_plies) return lineDone();
  const inEntry = q.path.length < q.entry.length;
  if (turnOf(q.path) !== q.me) {
    let san, why = "", cand = null;
    if (inEntry) san = q.entry[q.path.length];
    else {
      const cs = candidates(nd, turnOf(q.path), O);
      if (!cs.length) return lineDone();
      cand = chooseMove(cs, q.path, q.leaves, q.prog);
      san = cand.san;
      why = theirText(cand);
    }
    q.busy = true;
    paint();
    await sleep(THEIR_PAUSE);
    play(san, "them", cand);
    q.them = why;
    q.busy = false;
  }
  q.marks = {};
  const here = at(book, q.path);
  // Where the book runs out on your turn you still play the engine's move (the quest tree's leaves include it).
  if (!here || (q.path.length >= q.entry.length && !repertoire(here, q.me, q.path, O))) return lineDone();
  q.firstTry = null;
  paint();
}

/** What their move is, in a few words, without giving a trap away. */
function theirText(c) {
  if (c.kinds.includes("common")) return `They play ${rankText(c)}.`;
  if (c.kinds.includes("best")) return `They play the engine's favourite here (${Math.round(100 * c.share) || "<1"}% of games).`;
  return `They play a rarer move: ${rankText(c)}.`;
}

function play(san, who, cand = null) {
  const m = q.game.move(san);
  q.path.push(m.san);
  q.last = { from: m.from, to: m.to };
  q.log.push({ san: m.san, who, cand, ok: null });
  q.sel = null;
  return m;
}

function onTap(s) {
  if (q.busy || q.phase !== "play" || turnOf(q.path) !== q.me) return;
  const p = q.game.get(s);
  if (q.sel) {
    const moves = q.game.moves({ verbose: true }).filter((m) => m.from === q.sel && m.to === s);
    // Promotion: a queen (the book has nothing else in the opening).
    const m = moves.find((x) => !x.promotion || x.promotion === "q");
    if (m) { q.sel = null; return answer(m); }
  }
  q.sel = p && p.color === q.game.turn() && q.sel !== s ? s : null;
  paint();
}

async function answer(m) {
  const nd = at(book, q.path), inEntry = q.path.length < q.entry.length;
  const rep = inEntry ? { san: q.entry[q.path.length], node: nd.k?.[q.entry[q.path.length]] } : repertoire(nd, q.me, q.path, O);
  if (inEntry) {
    if (m.san === rep.san) return accept(m, rep, 0, `The ${esc(q.fam.name)} starts this way.`);
    return miss(m, `This line is the ${esc(q.fam.name)}: it goes ${esc(numbered(q.entry))}.`);
  }
  let loss;
  const child = nd.k?.[m.san];
  if (child) loss = lossOf(nd, child, q.me);
  else {
    q.busy = true;
    note(`Checking <b>${esc(m.san)}</b>: it isn't in the book…`);
    paint();
    try {
      const g = new Chess(q.game.fen());
      g.move(m.san);
      const ev = await engine(), line = await ev(g.fen());
      const before = nd.e ?? (await ev(q.game.fen())).cp;   // every book position has an eval; this is a fallback
      loss = Math.max(0, (q.me === "w" ? 1 : -1) * (before - line.cp));
    } catch { loss = null; }
    q.busy = false;
    if (loss == null) { paint(); return note("Couldn't check that move. Try another."); }
  }
  if (loss <= O.answer_tolerance) return accept(m, rep, loss, null, child);
  const popular = kidsOf(nd)[0];
  const trapped = popular && popular.san === m.san && q.log.at(-1)?.cand?.kinds.includes("trap");
  miss(m, trapped ? `<b>${esc(m.san)}</b> is the move most people play here, and it's the trap: it gives away ${pawns(loss)}. Try again.`
    : `<b>${esc(m.san)}</b> gives away ${pawns(loss)} here. Try again.`);
}

function grade(ok) {
  q.firstTry = ok;
  const s = q.prog.stats;
  s.answered++;
  if (ok) { s.ok++; s.streak++; } else { s.streak = 0; q.misses++; }
  const prev = q.log.at(-1);
  if (prev?.cand?.kinds.includes("trap") && ok) q.prog.traps[pathKey(q.path)] = true;
  saveProg();
}

function miss(m, html) {
  if (q.firstTry === null) grade(false);
  sound.play("wrong");
  q.marks = { [m.to]: "no" };
  note(html);
  $("btn-show").hidden = false;
  paint();
  board.el.parentElement.animate?.([0, -7, 7, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 300 });
}

/** Your move counts. If it isn't your repertoire move, say so and carry on with the repertoire move. */
async function accept(m, rep, loss, why = null, child = null) {
  if (q.firstTry === null) grade(true);
  sound.play("right");
  const nd = at(book, q.path), mine = child || nd.k?.[m.san];
  const pct = (x) => (x ? `${Math.max(1, Math.round((100 * x.n) / nd.n))}%` : "");
  const prev = q.log.at(-1);
  const reveal = prev?.cand?.kinds.includes("trap") ? ` That was a trap: most people answer <b>${esc(prev.cand.trap)}</b>, which gives away ${pawns(lossOf(prev.cand.node, prev.cand.node.k[prev.cand.trap], q.me))}.`
    : prev?.cand?.kinds.includes("slip") ? ` Their move was a mistake (it gave away ${pawns(prev.cand.loss)}), and this punishes it.` : "";
  $("btn-show").hidden = true;
  let text;
  if (why) text = why;
  else if (m.san === rep.san) text = `Right${mine ? `: the main move here, played in ${pct(mine)} of games` : ""}.`;
  else text = `Good too${loss > 0 ? ` (only ${pawns(loss)} off the best)` : ""}. Your repertoire move here is <b>${esc(rep.san)}</b>${rep.node ? `, played in ${pct(rep.node)} of games` : ""}; the quest goes on with it.`;
  note(text + reveal);
  const san = m.san === rep.san ? m.san : rep.san;
  if (san !== m.san) {
    q.game.move(m.san);       // show your move, then swap in the repertoire move
    q.last = { from: m.from, to: m.to };
    q.marks = { [m.to]: "ok" };
    q.busy = true;
    paint();
    await sleep(700);
    q.game.undo();
    q.busy = false;
  }
  const played = play(san, "me");
  q.log.at(-1).ok = q.firstTry;
  q.marks = { [played.to]: "ok" };
  paint();
  await sleep(150);
  step();
}

function show() {
  if (q.busy || q.phase !== "play") return;
  const nd = at(book, q.path), inEntry = q.path.length < q.entry.length;
  const rep = inEntry ? { san: q.entry[q.path.length] } : repertoire(nd, q.me, q.path, O);
  if (!rep) return;
  if (q.firstTry === null) grade(false);
  note(`The move here is <b>${esc(rep.san)}</b>.`);
  $("btn-show").hidden = true;
  const played = play(rep.san, "me");
  q.log.at(-1).ok = false;
  q.marks = { [played.to]: "ok" };
  paint();
  sleep(500).then(step);
}

async function lineDone() {
  q.phase = "done";
  const key = pathKey(q.path), p = q.prog;
  // The line counts as finished only where the quest tree ends; a line that ran out early isn't one of its leaves.
  const leaf = q.leaves.find((l) => pathKey(l) === key) ? key : null;
  if (leaf) {
    p.done[leaf] = true;
    p.boxes[leaf] = q.misses ? 1 : Math.min(5, (p.boxes[leaf] || 0) + 1);
    p.seen[leaf] = p.turn++;
  }
  await saveProg();
  const finished = q.leaves.filter((l) => p.done[pathKey(l)]).length;
  const mine = q.log.filter((x) => x.who === "me"), right = mine.filter((x) => x.ok).length;
  const all = finished === q.leaves.length;
  $("q-done").innerHTML = `<div class="fb ${q.misses ? "no" : "ok"}" role="status"><div class="fb-head"><h2>${all ? "Quest complete" : "Line done"}</h2></div>` +
    `<p>${right} of ${mine.length} of your moves right first time. ${all ? `You've finished all ${q.leaves.length} lines; from here they come back worst-answered first.`
      : `${finished} of ${q.leaves.length} lines finished.`}</p></div>`;
  $("btn-next").hidden = false;
  $("btn-next").focus({ preventScroll: true });
  paint();
}

function note(html) {
  $("q-note").innerHTML = html || "";
  $("q-note").hidden = !html;
}

// ---------- painting ----------

function paint() {
  const myTurn = turnOf(q.path) === q.me && q.phase === "play";
  const targets = q.sel && myTurn ? q.game.moves({ verbose: true }).filter((m) => m.from === q.sel).map((m) => m.to) : [];
  board.draw(q.game.fen(), { last: q.last, onTap, sel: q.sel, targets, marks: q.marks });
  const name = nameAt(book, q.path);
  $("q-name").innerHTML = name ? `<span class="label">${esc(name[0])}</span> ${esc(name[1])}` : "Starting position";
  $("q-line").innerHTML = q.log.map((x, i) =>
    `<span class="crumb ${x.who === "me" ? "yours" : "theirs"}${x.ok === false ? " missed" : ""}">${esc(moveText(i, x.san))}</span>`).join("");
  $("q-prompt").textContent = q.phase === "done" ? "Line done." : q.busy && !myTurn ? `${COLOR[turnOf(q.path)]} to move…`
    : myTurn ? (q.path.length < q.entry.length ? `Play the ${q.fam.name}.` : `Your move as ${COLOR[q.me]}.`) : "";
  $("q-them").textContent = myTurn && q.path.length > q.entry.length ? q.them || "" : "";
  paintStats();
}

function paintStats() {
  const p = q.prog, s = p.stats;
  $("q-lines").textContent = `${q.leaves.filter((l) => p.done[pathKey(l)]).length}/${q.leaves.length}`;
  $("q-traps").textContent = `${Object.keys(p.traps).length}/${q.count.trap}`;
  $("q-acc").textContent = s.answered ? `${Math.round((100 * s.ok) / s.answered)}%` : "–";
  $("q-streak").textContent = s.streak;
}

// ---------- page ----------

function fillOpenings(sel) {
  const el = $("opening");
  const top = fams.filter((f) => f.n >= book.n * 0.0005);
  const group = (label, side) => `<optgroup label="${label}">` + top.filter((f) => f.side === side)
    .map((f) => `<option value="${esc(f.name)}" data-side="${f.side}">${esc(f.name)} · ${esc(numbered(f.path))}</option>`).join("") + "</optgroup>";
  el.innerHTML = `<option value="${ALL}">Your whole repertoire, from move one</option>` + group("Openings White chooses", "w") + group("Openings Black chooses", "b");
  sel.select.value = sel.select.querySelector(`option[value="${CSS.escape(sel.value || "")}"]`) ? sel.value : (top[0]?.name ?? ALL);
}

async function main() {
  setupTheme();
  fitHero();
  document.fonts?.ready.then(fitHero);
  new ResizeObserver(fitHero).observe(document.querySelector(".stage"));
  board = new Board($("board"), $("arrows"));
  store = await openStore();
  setStatus("Loading the opening book…");
  try {
    const res = await fetch(new URL("../openings/book.json", import.meta.url));
    if (!res.ok) throw new Error(`the book answered ${res.status}`);
    const data = await res.json();
    book = data.root;
    $("foot-note").textContent = "Moves and results: Lichess open database, CC0";
    $("foot-note").title = data._source;
  } catch (err) {
    setStatus("");
    $("error").textContent = `The opening book didn't load (${err.message}).`;
    $("error").hidden = false;
    return;
  }
  setStatus("");
  fams = families(book);
  const last = await store.get("openings-last");
  fillOpenings({ select: $("opening"), value: last?.opening });
  const openingSel = new Select($("opening"));
  const sideFor = () => $("opening").selectedOptions[0]?.dataset.side;
  const pickSide = (s) => { const r = document.querySelector(`input[name=side][value="${s}"]`); if (r) r.checked = true; };
  pickSide(last?.side || sideFor() || "w");
  $("opening").addEventListener("change", () => { const s = sideFor(); if (s) pickSide(s); });
  openingSel.sync();
  $("btn-go").disabled = false;
  $("btn-change").addEventListener("click", () => { $("start").classList.add("open"); });
  $("start").addEventListener("submit", (e) => {
    e.preventDefault();
    startQuest($("opening").value, sideNow()).catch((err) => {
      console.error(err);
      $("error").textContent = `Something went wrong: ${err.message}`;
      $("error").hidden = false;
    });
  });
  $("btn-show").addEventListener("click", show);
  $("btn-next").addEventListener("click", newLine);
}

main();
