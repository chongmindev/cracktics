// Openings page: pick an opening and a side, then play every line of it from move one. At your turns you find a good
// move (the book's evals judge it; Stockfish judges a move the book doesn't have); at theirs, they play one of the
// moves worth learning to answer: the most played, sidelines, the engine's favourite, common mistakes and rare traps
// (src/quest.js). Lines you haven't finished come first; then the ones you answered worst.

import { Chess } from "chess.js";
import { Board } from "./board.js";
import { liftPieces } from "./drag.js";
import { EnginePool, Evaluator, LichessCloud } from "./evals.js";
import { numbered as plyText, openingMiss } from "./explain.js";
import { at, candidates, chooseMove, families, fenAt, kidsOf, lossOf, nameAt, pathKey, posKey, questTree, rankText, repertoire, scoreOf, turnOf } from "./quest.js";
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

let book = null, fams = [], store = null, board = null, evaluate = null, analysePv = null;
let verdicts = null;   // openings/moves.json: {pos: {position key: {san: loss | [loss, reply]}}}, every move at every quest position
let q = null;   // the quest: {fam, me, entry, leaves, count, prog, key, path, game, sel, marks, misses, firstTry, busy, phase, last, view}

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
  const pool = new EnginePool(engines);
  const ev = new Evaluator({ store, pool, cloud: new LichessCloud({ mateScore: cfg.engine.mate_score }) });
  evaluate = async (fen) => (await ev.forGame()(fen, O.book_depth, 1))[0];
  analysePv = async (fen) => (await pool.analyse(fen, O.book_depth, 1, true))[0];   // the whole line, to explain a miss
  return evaluate;
}

// ---------- progress ----------

// done/boxes/seen/times: per line (leaf key). pos: per position you answered (path key) {n: times, ok: right first
// try last time}. Older saves lack times and pos: withDefaults fills them in.
const freshProg = () => ({ done: {}, boxes: {}, seen: {}, times: {}, pos: {}, turn: 0, traps: {}, stats: { answered: 0, ok: 0, streak: 0 } });
const withDefaults = (p) => ({ ...freshProg(), ...p });

async function saveProg() {
  await store.set(q.key, q.prog);
  // The opening list shows how far each quest has got.
  const index = (await store.get("openings-index")) || {};
  index[q.key] = { done: q.leaves.filter((l) => q.prog.done[pathKey(l)]).length, total: q.leaves.length };
  await store.set("openings-index", index);
}

/** The lines of the quest that go through `path`, and how many of them you've finished. */
function branch(path) {
  const under = q.leaves.filter((l) => l.length >= path.length && path.every((s, i) => l[i] === s));
  return { total: under.length, done: under.filter((l) => q.prog.done[pathKey(l)]).length };
}

// ---------- the quest ----------

async function startQuest(famName, me) {
  const fam = famName === ALL ? { name: "Whole repertoire", path: [], side: me } : fams.find((f) => f.name === famName);
  if (!fam) return;
  const entry = fam.path;
  const { leaves, count } = questTree(book, entry, me, O, O.book_plies);
  const key = `quest|${fam.name}|${me}`;
  q = { fam, me, entry, leaves, count, key, prog: withDefaults((await store.get(key)) || {}) };
  await store.set("openings-last", { opening: famName, side: me });
  board.white = me === "w";
  $("who").textContent = `${fam.name} as ${COLOR[me]} · ${leaves.length} line${leaves.length === 1 ? "" : "s"}`;
  $("start").classList.remove("open");
  document.body.dataset.view = "report";
  $("report").hidden = false;
  engine().catch(() => {});   // warm up for moves the book doesn't have
  await saveProg();
  newLine();
}

function newLine() {
  Object.assign(q, { path: [], game: new Chess(), sel: null, marks: {}, misses: 0, firstTry: null, busy: false, phase: "play", last: null, log: [], view: null, missToken: null, seenHere: null });
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
  q.seenHere = q.path.length >= q.entry.length ? q.prog.pos[pathKey(q.path)] || null : null;   // before this try counts
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
  if (q.view) { q.view = null; paint(); }   // back from looking at why a move was wrong
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
  let loss, reply = null;
  const child = nd.k?.[m.san];
  // One verdict per position and move, worked out ahead of time (tools/book-moves.mjs), so it never changes
  // between visits or depends on which engine answered. Your repertoire move is always right.
  const known = m.san === rep?.san ? undefined : verdicts?.pos[posKey(q.game.fen())]?.[m.san];
  if (m.san === rep?.san) loss = child ? lossOf(nd, child, q.me) : 0;
  else if (known !== undefined) {
    loss = Array.isArray(known) ? known[0] : known;
    reply = Array.isArray(known) ? known[1] : child?.b || null;
  } else if (child) { loss = lossOf(nd, child, q.me); reply = child.b || null; }
  else {
    q.busy = true;
    note(`Checking <b>${esc(m.san)}</b>…`);
    paint();
    try {
      const g = new Chess(q.game.fen());
      g.move(m.san);
      const ev = await engine(), line = await ev(g.fen());
      const before = nd.e ?? (await ev(q.game.fen())).cp;   // every book position has an eval; this is a fallback
      loss = Math.max(0, (q.me === "w" ? 1 : -1) * (before - line.cp));
      reply = line.move || null;
    } catch { loss = null; }
    q.busy = false;
    if (loss == null) { paint(); return note("Couldn't check that move. Try another."); }
  }
  if (m.san === rep?.san || loss <= O.answer_tolerance) return accept(m, rep, loss, null, child);
  const popular = kidsOf(nd)[0];
  const trapped = popular && popular.san === m.san && q.log.at(-1)?.cand?.kinds.includes("trap");
  miss(m, trapped ? `<b>${esc(m.san)}</b> is the move most people play here, and it's the trap: it gives away ${pawns(loss)}.`
    : `<b>${esc(m.san)}</b> gives away ${pawns(loss)} here.`, { reply, child, nd });
}

function grade(ok) {
  q.firstTry = ok;
  const s = q.prog.stats;
  s.answered++;
  if (ok) { s.ok++; s.streak++; } else { s.streak = 0; q.misses++; }
  const prev = q.log.at(-1);
  if (prev?.cand?.kinds.includes("trap") && ok) q.prog.traps[pathKey(q.path)] = true;
  if (q.path.length >= q.entry.length) {
    const k = pathKey(q.path), was = q.prog.pos[k];
    q.prog.pos[k] = { n: (was?.n || 0) + 1, ok };
  }
  saveProg();
}

function miss(m, html, why = null) {
  if (q.firstTry === null) grade(false);
  sound.play("wrong");
  q.marks = { [m.to]: "no" };
  q.view = null;
  note(html + (why ? "" : " Try again."));
  $("btn-show").hidden = false;
  paint();
  board.el.parentElement.animate?.([0, -7, 7, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 300 });
  if (why) explainMiss(m, html, why);
}

/** UCI to SAN from `fen`, or null. */
function sanOf(fen, uci) {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return null; }
}

/**
 * Why your move was wrong, under the "gives away" line: what it does wrong on the board, their best answer (stepped
 * on the board like a drill's line when there's a tactic in it), and how it scores in the book's games.
 * The board shows your move and their answer; tap the board (or "Try again") to go back and find a better move.
 */
async function explainMiss(m, head, { reply, child, nd }, { path = [...q.path], back = "Try again", onBack = null, label = "Their best answer" } = {}) {
  const token = q.missToken = {}, fen = fenAt(path);
  const after = new Chess(fen); after.move(m.san);
  const replySan = reply ? sanOf(after.fen(), reply) : null;
  const stats = child && child.n >= O.book_min_games
    ? ` In the book's ${child.n.toLocaleString()} games with it, ${COLOR[q.me]} scores ${Math.round(100 * scoreOf(child, q.me))}%` +
      ` (${Math.round(100 * scoreOf(nd, q.me))}% from this position overall).` : "";
  let first = true;
  const render = (w, wait) => {
    if (q.missToken !== token) return;
    const { reasons, walk } = w;
    const rows = walk ? walk.steps.map((st, k) =>
      `<li><button type="button" data-k="${k}"><b>${esc(plyText(st.ply.before, st.ply.move))}</b><span>${st.text}</span></button></li>`).join("") : "";
    note(`<span class="miss-head">${head}</span>` +
      (reasons.length ? `<ul class="miss-why">${reasons.map((r) => `<li>${r}</li>`).join("")}</ul>` : "") +
      (walk ? `<span class="label miss-label">${label}${walk.idea ? ", and what follows" : ""}</span><ol class="walk-steps">${rows}</ol>` +
        (walk.idea ? `<span class="walk-sum">${esc(walk.summary)}</span>` : "") : "") +
      (wait ? `<span class="walk-wait">Working out the line…</span>` : "") +
      (stats ? `<span class="miss-stats">${stats.trim()}</span>` : "") +
      `<button type="button" class="${onBack ? "btn primary" : "link-btn"} miss-back">${back}</button>`);
    const box = $("q-note");
    const view = (k) => {
      const st = walk.steps[k];
      q.view = { fen: st.ply.after, last: { from: st.ply.move.from, to: st.ply.move.to }, wrong: m, k };
      box.querySelectorAll(".walk-steps li").forEach((li, j) => li.classList.toggle("on", j === k));
      paint();
    };
    box.querySelector(".walk-steps")?.addEventListener("click", (e) => { const t = e.target.closest("[data-k]"); if (t) view(+t.dataset.k); });
    box.querySelector(".miss-back").addEventListener("click", () => {
      q.view = null;
      box.querySelectorAll(".walk-steps li").forEach((li) => li.classList.remove("on"));
      if (onBack) onBack(); else paint();
    });
    if (walk && first) view(0);   // show your move and their answer straight away
    else if (walk && q.view) view(Math.min(q.view.k, walk.steps.length - 1));
    first = false;
  };
  // First from the board and the book alone; then again once the engine's line after their answer is in.
  render(openingMiss({ path, played: m.san, reply: replySan }), !!replySan);
  if (!replySan) return;
  let line = null;
  try {
    await engine();
    const g = new Chess(after.fen()); g.move(replySan);
    line = await analysePv(g.fen());
  } catch {}
  if (q.missToken !== token) return;
  render(openingMiss({ path, played: m.san, reply: replySan, line }), false);
}

/** Your move counts. If it isn't your repertoire move, say so and carry on with the repertoire move. */
async function accept(m, rep, loss, why = null, child = null) {
  if (q.firstTry === null) grade(true);
  q.view = null; q.missToken = null;
  sound.play("right");
  const nd = at(book, q.path), mine = child || nd.k?.[m.san];
  const pct = (x) => (x ? `${Math.max(1, Math.round((100 * x.n) / nd.n))}%` : "");
  const prev = q.log.at(-1);
  const trap = prev?.cand?.kinds.includes("trap") ? prev.cand : null;
  const trapHead = trap ? `That was a trap: most people answer <b>${esc(trap.trap)}</b>, which gives away ${pawns(lossOf(trap.node, trap.node.k[trap.trap], q.me))}. Here's how they punish it.` : "";
  const trapAt = trap ? { path: [...q.path], move: new Chess(q.game.fen()).move(trap.trap), node: trap.node.k[trap.trap], nd } : null;
  const reveal = trap ? ""
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
  if (!trapAt) return step();
  // A trap: stop and show it (the popular answer, crossed, and how they punish it) before the line goes on.
  q.busy = true;
  explainMiss(trapAt.move, `${text} ${trapHead}`, { reply: trapAt.node?.b || null, child: trapAt.node, nd: trapAt.nd },
    { path: trapAt.path, back: "Continue", label: "How they punish it", onBack: () => { q.busy = false; q.missToken = null; note(""); step(); } });
}

function show() {
  if (q.busy || q.phase !== "play") return;
  const nd = at(book, q.path), inEntry = q.path.length < q.entry.length;
  const rep = inEntry ? { san: q.entry[q.path.length] } : repertoire(nd, q.me, q.path, O);
  if (!rep) return;
  if (q.firstTry === null) grade(false);
  q.view = null; q.missToken = null;
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
    p.times[leaf] = (p.times[leaf] || 0) + 1;
  }
  await saveProg();
  const finished = q.leaves.filter((l) => p.done[pathKey(l)]).length;
  const mine = q.log.filter((x) => x.who === "me"), right = mine.filter((x) => x.ok).length;
  const all = finished === q.leaves.length;
  $("q-done").innerHTML = `<div class="fb ${q.misses ? "no" : "ok"}" role="status"><div class="fb-head"><h2>${all ? "Quest complete" : "Line done"}</h2></div>` +
    `<p>${leaf ? (p.times[leaf] === 1 ? "A new line: first time through. " : `You've finished this line ${p.times[leaf]} times now. `) : ""}` +
    `${right} of ${mine.length} of your moves right first time. ${all ? `You've finished all ${q.leaves.length} lines; from here they come back worst-answered first.`
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
  if (q.view) {
    // Looking at why your move was wrong: your move (crossed) and their answer, with arrows; tap to go back.
    const w = q.view.wrong;
    board.draw(q.view.fen, { last: q.view.last, onTap, marks: { [w.to]: "no" },
      arrows: [...(q.view.k === 0 ? [{ from: w.from, to: w.to, weight: 0.4, kind: "wrong" }] : []),
        { from: q.view.last.from, to: q.view.last.to, weight: 1, kind: "them" }] });
  } else board.draw(q.game.fen(), { last: q.last, onTap, sel: q.sel, targets, marks: q.marks });
  const name = nameAt(book, q.path);
  $("q-name").innerHTML = name ? `<span class="label">${esc(name[0])}</span> ${esc(name[1])}` : "Starting position";
  $("q-line").innerHTML = q.log.map((x, i) =>
    `<span class="crumb ${x.who === "me" ? "yours" : "theirs"}${x.ok === false ? " missed" : ""}">${esc(moveText(i, x.san))}</span>`).join("");
  $("q-prompt").textContent = q.phase === "done" ? "Line done." : q.busy && !myTurn ? `${COLOR[turnOf(q.path)]} to move…`
    : myTurn ? (q.path.length < q.entry.length ? `Play the ${q.fam.name}.` : `Your move as ${COLOR[q.me]}.`) : "";
  $("q-them").textContent = myTurn && q.path.length > q.entry.length ? q.them || "" : "";
  paintSeen(myTurn);
  paintStats();
}

/** Have you been here before: this position (and how it went last time), and the lines through it. */
function paintSeen(myTurn) {
  const el = $("q-seen");
  if (!myTurn || q.path.length < q.entry.length) { el.innerHTML = ""; return; }
  const pos = q.seenHere, br = branch(q.path);
  const here = !pos ? `<span class="tag seen new">New position</span>`
    : `<span class="tag seen ${pos.ok ? "ok" : "no"}">Seen ${pos.n === 1 ? "once" : `${pos.n}×`} · ${pos.ok ? "right" : "missed"} last time</span>`;
  const lines = br.total > 1 ? `<span class="tag seen">${br.done}/${br.total} lines from here done</span>`
    : br.total === 1 && br.done ? `<span class="tag seen ok">This line: done before</span>` : "";
  el.innerHTML = here + lines;
}

function paintStats() {
  const p = q.prog, s = p.stats;
  $("q-lines").textContent = `${q.leaves.filter((l) => p.done[pathKey(l)]).length}/${q.leaves.length}`;
  $("q-traps").textContent = `${Object.keys(p.traps).length}/${q.count.trap}`;
  $("q-acc").textContent = s.answered ? `${Math.round((100 * s.ok) / s.answered)}%` : "–";
  $("q-streak").textContent = s.streak;
}

// ---------- page ----------

/**
 * The opening list for the side you play: openings you choose first, then the ones you'll meet (the other side's
 * choices), each most played first, with the share of the book's games that reach it.
 */
function fillOpenings(sel, index = {}, side = "w") {
  const el = $("opening"), other = side === "w" ? "b" : "w";
  const share = (f) => { const x = (100 * f.n) / book.n; return x >= 1 ? `${Math.round(x)}%` : x >= 0.1 ? `${x.toFixed(1)}%` : "<0.1%"; };
  const prog = (name) => ["w", "b"].map((c) => index[`quest|${name}|${c}`]).map((x, i) => x?.done ? ` · ${x.done}/${x.total} as ${COLOR["wb"[i]]}` : "").join("");
  const top = fams.filter((f) => f.n >= book.n * 0.0005);
  const group = (label, side) => `<optgroup label="${label}">` + top.filter((f) => f.side === side)
    .map((f) => `<option value="${esc(f.name)}" data-side="${f.side}">${esc(f.name)} · ${esc(numbered(f.path))} · ${share(f)}${prog(f.name)}</option>`).join("") + "</optgroup>";
  el.innerHTML = `<option value="${ALL}">Your whole repertoire, from move one${prog("Whole repertoire")}</option>` +
    group(`Your openings as ${COLOR[side]} (you choose)`, side) + group(`Openings you'll face (${COLOR[other]} chooses)`, other);
  sel.select.value = sel.select.querySelector(`option[value="${CSS.escape(sel.value || "")}"]`) ? sel.value : (top.find((f) => f.side === side)?.name ?? ALL);
}

async function main() {
  setupTheme();
  fitHero();
  document.fonts?.ready.then(fitHero);
  new ResizeObserver(fitHero).observe(document.querySelector(".stage"));
  board = new Board($("board"), $("arrows"));
  liftPieces(board.el, {
    canLift: (s) => !!q && !q.busy && q.phase === "play" && turnOf(q.path) === q.me && q.game.get(s)?.color === q.game.turn(),
    tap: (s) => onTap(s),
    selected: () => q?.sel ?? null,
  });
  store = await openStore();
  setStatus("Loading the opening book…");
  try {
    const res = await fetch(new URL("../openings/book.json", import.meta.url));
    if (!res.ok) throw new Error(`the book answered ${res.status}`);
    const data = await res.json();
    book = data.root;
    // Verdicts load alongside; until they arrive (or if they're missing) moves are judged as before.
    fetch(new URL("../openings/moves.json", import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((d) => { verdicts = d; }).catch(() => {});
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
  const pickSide = (s) => { const r = document.querySelector(`input[name=side][value="${s}"]`); if (r) r.checked = true; };
  pickSide(last?.side || "w");
  const refill = async () => fillOpenings({ select: $("opening"), value: $("opening").value || last?.opening }, (await store.get("openings-index")) || {}, sideNow());
  await refill();
  const openingSel = new Select($("opening"));
  // The list follows the side you play (the opening you picked stays picked).
  document.querySelectorAll("input[name=side]").forEach((r) => r.addEventListener("change", async () => { await refill(); openingSel.sync(); }));
  openingSel.sync();
  $("btn-go").disabled = false;
  $("btn-change").addEventListener("click", async () => {
    await refill();
    openingSel.sync();
    $("start").classList.add("open");
  });
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
