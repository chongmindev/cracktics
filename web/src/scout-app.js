// Scout page: an opponent's username -> their finished games -> their opening tree -> weak spots, an explorer
// of what they play, their habits checked with Stockfish, and game plans: full lines that punish the costly ones. Fair play: finished games only, as in the drill.

import { Chess } from "chess.js";
import { Board } from "./board.js";
import { ChessCom } from "./chesscom.js";
import { EnginePool, Evaluator } from "./evals.js";
import { numbered, refutation } from "./explain.js";
import { Lichess } from "./lichess.js";
import { buildTree, byFamily, bookExit, family, habits, kidsOf, lineOf, numberLine, predictability, rankPlans, theirMoves, verdictOf, walk, weakSpots } from "./scout.js";
import { Select } from "./select.js";
import { IdbStore, MemoryStore } from "./store.js";
import { UciEngine } from "./uci.js";
import { fitHero, poolSize, setupTheme, workerTransport } from "./ui.js";

const cfg = await (await fetch(new URL("./config.json", import.meta.url))).json();
const P = cfg.scout;
const ENGINE_URL = "engine/stockfish-19-lite-single.js";
const SITE_NAME = { chesscom: "Chess.com", lichess: "Lichess" };
const COLOR = { w: "White", b: "Black" };
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (x) => `${Math.round(100 * x)}%`;
const games = (n) => `${n} game${n === 1 ? "" : "s"}`;
/** Their win rate in a node (draws aside; the W/D/L bar shows those). Every percentage on the page says what it counts. */
const won = (nd) => (nd.n ? nd.w / nd.n : 0);

let names = null, store = null, pool = null, board = null;
let state = null;   // {tree, mine, theirs, username, site, node, judged: Map(move node -> {loss, bestSan}), plans, plan, run}

async function openStore() {
  try { return await IdbStore.open(); } catch { return new MemoryStore(); }
}

/** Range select value -> fetch range, as on the drill page. */
function parseRange(value) {
  if (value === "all") return { all: true };
  const n = Number(value.slice(1));
  return value[0] === "g" ? { games: n } : { days: n };
}

const sideNow = () => document.querySelector("input[name=side]:checked")?.value || "w";

/** W/D/L bar from their side: their wins, draws, losses. */
function wdl(nd) {
  const w = (100 * nd.w) / nd.n, d = (100 * nd.d) / nd.n;
  return `<span class="wdl" title="Their results: ${nd.w} won, ${nd.d} drawn, ${nd.l} lost"><i class="w" style="width:${w}%"></i><i class="d" style="width:${d}%"></i><i class="l"></i></span>`;
}

/** "1.e4 c5 2.Nf3" for a node, with the move numbers. */
const lineText = (nd) => numberLine(lineOf(nd)) || "Start";

function setStatus(text, frac = null) {
  $("status").hidden = !text;
  $("status-text").textContent = text || "";
  if (frac != null) $("bar").style.width = `${Math.round(100 * frac)}%`;
}

/** One account's finished games (newest first), from whichever site it's on. */
function fetchGames({ site, username }, range, timeClasses, status) {
  return site === "lichess"
    ? new Lichess({ store }).games(username, { range, timeClasses, onProgress: (n) => status(`${n}`) })
    : new ChessCom({ store, minInterval: cfg.fetch.min_interval }).games(username, { range, timeClasses });
}

/** "dudacio" for one account or the same name on both sites; "dudacio / dud_lichess" otherwise. */
const nameOf = (accounts) => [...new Map(accounts.map((a) => [a.username.toLowerCase(), a.username])).values()].join(" / ");

/**
 * accounts: [{site, username}], one person's accounts (a Chess.com one and a Lichess one, say). Their games are
 * pooled into one tree; the range applies to each account.
 */
async function analyze(accounts, rangeValue, timeClasses, mine) {
  const run = {};
  state = { run };
  const theirs = mine === "w" ? "b" : "w", username = nameOf(accounts);
  $("error").hidden = true;
  $("report").hidden = true;
  document.body.dataset.view = "loading";
  const games = [];
  try {
    names ??= await (await fetch(new URL("./openings.json", import.meta.url))).json();
    for (const [i, a] of accounts.entries()) {   // one at a time: each site has its own rate limits
      const msg = `Fetching ${a.username}'s finished games from ${SITE_NAME[a.site]}…`;
      setStatus(msg, (0.1 + i) / accounts.length);
      try {
        games.push(...await fetchGames(a, parseRange(rangeValue), timeClasses, (n) => setStatus(`${msg} ${n}`)));
      } catch (e) {
        throw new Error(accounts.length > 1 ? `${a.username} on ${SITE_NAME[a.site]}: ${e.message}` : e.message);
      }
      if (state.run !== run) return;
    }
  } catch (e) {
    if (state.run !== run) return;
    setStatus("");
    $("error").textContent = e.message;
    $("error").hidden = false;
    document.body.dataset.view = "intro";
    return;
  }
  if (state.run !== run) return;
  // Pooled newest first; a game seen twice (the same account entered twice) counts once.
  const seen = new Set();
  const theirGames = games.filter((g) => g.color === theirs && !seen.has(g.link) && seen.add(g.link)).sort((a, b) => b.endTime - a.endTime);
  if (!theirGames.length) {
    setStatus("");
    $("error").textContent = `No finished ${timeClasses.join("/") || ""} games where ${username} had ${COLOR[theirs]}. Try a longer range or more time controls.`;
    $("error").hidden = false;
    document.body.dataset.view = "intro";
    return;
  }
  const [{ site, username: first }, also = null] = accounts;
  await store.set("scout-last", { site, username: first, also, range: rangeValue, timeClasses, side: mine });
  const tree = buildTree(theirGames, { plies: P.plies, names });
  Object.assign(state, { tree, mine, theirs, username, site, node: tree.root, judged: new Map(), bests: new Map(), evaluate: null, check: null, plans: null, plan: null });
  setStatus("");
  board.white = mine === "w";
  const where = accounts.length > 1 ? ` (${[...new Set(accounts.map((a) => SITE_NAME[a.site]))].join(" + ")})` : site === "lichess" ? " (Lichess)" : "";
  $("who").textContent = `${username}${where} as ${COLOR[theirs]} · ${theirGames.length} games`;
  $("start").classList.remove("open");
  document.body.dataset.view = "report";
  $("report").hidden = false;
  paintSummary();
  paintWeak();
  paintHabits();
  goTo(tree.root);
  selectTab("plan");
  paintPlans();
  checkMoves(run);
}

function paintSummary() {
  const { tree, theirs } = state;
  $("r-games").textContent = tree.games;
  $("r-score").textContent = pct(won(tree.root));
  $("r-pred").textContent = pct(predictability(tree, theirs));
  const exit = bookExit(tree);
  $("r-book").textContent = exit ? `Move ${exit}` : "–";
}

/** Weak spots, then their results by opening. Each row opens that line in the explorer. */
function paintWeak() {
  const { tree, theirs, mine, username } = state;
  const spots = weakSpots(tree, theirs, { minGames: P.min_games, gap: P.weak_gap, max: P.weak_spots });
  const fams = byFamily(tree, { minGames: P.family_min_games });
  const rows = spots.map((s, i) => `<li><button type="button" class="row" data-weak="${i}">
      <span class="row-main"><b class="mono">${esc(lineText(s.node))}</b><span class="row-name">${esc(s.node.name || "Unnamed line")}</span></span>
      <span class="row-side"><b>${pct(won(s.node))}</b><span class="label">they won · ${games(s.node.n)}</span></span>${wdl(s.node)}</button></li>`).join("");
  $("pane-weak").innerHTML =
    `<p class="pane-intro">Lines you can steer into as ${COLOR[mine]} where ${esc(username)} does much worse than usual. Overall they win ${pct(won(tree.root))} of these games; the % on each line is how many they won there.</p>` +
    (spots.length ? `<ol class="rows">${rows}</ol>`
      : `<p class="empty">No line with ${P.min_games}+ games where they do clearly worse. More games (a longer range or more time controls) may show some.</p>`) +
    (fams.length ? `<h3 class="label pane-head">By opening</h3><ol class="rows fams">` + fams.map((f, i) => `<li><button type="button" class="row" data-fam="${i}">
      <span class="row-main"><span class="row-name">${esc(f.family)}</span><span class="label">${esc(f.eco)}</span></span>
      <span class="row-side"><b>${pct(f.n ? f.w / f.n : 0)}</b><span class="label">they won · ${games(f.n)}</span></span>${wdl(f)}</button></li>`).join("") + `</ol>` : "");
  $("pane-weak").onclick = (e) => {
    const b = e.target.closest("button.row");
    if (!b) return;
    if (b.dataset.weak) openInTree(spots[+b.dataset.weak].node);
    else openInTree(familyNode(fams[+b.dataset.fam].family));
  };
}

/** Where an opening family starts in their tree: its most played position that carries the name itself. */
function familyNode(f) {
  let best = null;
  for (const nd of walk(state.tree.root))
    if (names[nd.key] && family(nd.name) === f && (!best || nd.n > best.n || (nd.n === best.n && nd.ply < best.ply))) best = nd;
  return best || state.tree.root;
}

function openInTree(nd) {
  selectTab("tree");
  goTo(nd);
}

/** The explorer: the line so far (each move clickable), the opening's name, and the next moves they've seen here. */
function goTo(nd, { judge: wantJudge = true } = {}) {
  state.node = nd;
  const { theirs, username } = state;
  const kids = kidsOf(nd), theirTurn = nd.fen.split(" ")[1] === theirs;
  const path = [];
  for (let x = nd; x; x = x.parent) path.unshift(x);
  const crumbs = path.map((x, i) => i === 0
    ? `<button type="button" class="crumb" data-ply="0">Start</button>`
    : `<button type="button" class="crumb" data-ply="${i}">${i % 2 === 1 ? `${(i + 1) / 2}.` : ""}${esc(x.san)}</button>`).join("");
  const total = kids.reduce((s, k) => s + k.n, 0);
  // Their costliest move here, if Stockfish has found one, and what was better.
  const slip = theirTurn ? kids.filter((k) => (state.judged.get(k)?.loss ?? 0) >= P.slip_loss).sort((a, b) => b.n - a.n)[0] : null;
  const sj = slip && state.judged.get(slip), planI = slip ? state.plans?.findIndex((p) => p.move === slip && p.w) ?? -1 : -1;
  const rows = kids.map((k) => `<li><button type="button" class="row" data-san="${esc(k.san)}">
      <span class="row-main"><span class="row-move"><b class="mono">${esc(k.san)}</b>${tagOf(k)}</span><span class="row-name">${k.name && k.name !== nd.name ? `${esc(k.name)} · ` : ""}they won ${pct(won(k))}</span></span>
      <span class="row-side"><b>${pct(k.n / total)}</b><span class="label">played · ${games(k.n)}</span></span>${wdl(k)}</button></li>`).join("");
  const links = nd.links.slice(0, 3).map((l, i) => `<a href="${esc(l)}" target="_blank" rel="noopener">Game ${i + 1} ↗</a>`).join("");
  $("pane-tree").innerHTML =
    `<nav class="crumbs" aria-label="Line">${crumbs}</nav>` +
    `<p class="opening"><span class="label">${esc(nd.eco || "")}</span> ${esc(nd.name || "Starting position")}</p>` +
    `<p class="pane-intro">${nd.n === 1 ? "One of their games" : `${nd.n} of their games`} reached this. ` +
      (kids.length ? (theirTurn ? `<b>${esc(username)}</b> to move: what they played here.` : `Your move: what their opponents played, and how ${esc(username)} did.`) +
        ` Each move: how often it was played, how often ${esc(username)} won after it, and Stockfish's verdict.`
        : "Their games go different ways from here.") + `</p>` +
    (slip ? `<p class="slip-note"><b>Use this:</b> ${esc(username)} played <b>${esc(slip.san)}</b> here in ${slip.n} of ${nd.n} games, and it gives away ` +
      `about ${(sj.loss / 100).toFixed(1)} pawns; <b>${esc(sj.bestSan)}</b> was best.` +
      (planI >= 0 ? ` <button type="button" class="link-btn" data-plan-of="${planI}">See how to punish it</button>` : "") + `</p>` : "") +
    (kids.length ? `<ol class="rows">${rows}</ol>` : "") +
    (links ? `<p class="links label">Their latest games here: ${links}</p>` : "");
  $("pane-tree").onclick = (e) => {
    const c = e.target.closest(".crumb");
    if (c) return goTo(path[+c.dataset.ply]);
    const po = e.target.closest("[data-plan-of]");
    if (po) return openPlan(+po.dataset.planOf);
    const r = e.target.closest("button.row");
    if (r) goTo(nd.kids.get(r.dataset.san));
  };
  // Board: the position, the move that led here, and arrows for the moves played next (heavier = more often).
  const arrows = kids.slice(0, 4).map((k) => ({ from: k.uci.slice(0, 2), to: k.uci.slice(2, 4), weight: k.n / total, kind: theirTurn ? "theirs" : "yours" }));
  const last = nd.uci ? { from: nd.uci.slice(0, 2), to: nd.uci.slice(2, 4) } : null;
  board.draw(nd.fen, { last, arrows });
  if (wantJudge) judgeHere(nd);
}

/** Their habits (the same move most of the time), with Stockfish's verdict once checked. */
function paintHabits() {
  const { tree, theirs, username } = state;
  const list = state.habits ??= habits(tree, theirs, { minGames: P.habit_min_games, minShare: P.habit_min_share });
  const costly = (h) => (state.judged.get(h.move)?.loss ?? 0) >= P.slip_loss;
  const sorted = [...list].sort((a, b) => costly(b) - costly(a));
  $("pane-habits").innerHTML =
    `<p class="pane-intro">Positions ${esc(username)} reached at least ${P.habit_min_games} times and answered the same way most of the time, ` +
      `with Stockfish's verdict on that move. A habit that costs them is something to aim for.</p>` +
    (sorted.length ? `<ol class="rows">` + sorted.map((h) => `<li><button type="button" class="row" data-i="${list.indexOf(h)}">
      <span class="row-main"><span class="row-move"><b class="mono">${esc(moveText(h.move))}</b>${tagOf(h.move)}</span><span class="row-name">${esc(lineText(h.node))}</span></span>
      <span class="row-side"><b>${pct(h.share)}</b><span class="label">played · ${h.move.n} of ${h.node.n}</span></span></button></li>`).join("") + `</ol>`
      : `<p class="empty">No repeated choices yet. More games may show some.</p>`);
  $("pane-habits").onclick = (e) => { const b = e.target.closest("button.row"); if (b) openInTree(list[+b.dataset.i].node); };
}

const WORD = { best: "Best", good: "Good", dubious: "Dubious", mistake: "Mistake", blunder: "Blunder" };

/** Stockfish's verdict on a move as a tag ("Mistake −1.4"), or a placeholder while it's being checked. */
function tagOf(k) {
  const j = state.judged.get(k);
  if (!j) return state.evaluate ? `<span class="tag wait" title="Stockfish hasn't looked at this move yet">…</span>` : "";
  const v = verdictOf(j.loss, { best: j.best, dubious: P.dubious_loss, mistake: P.slip_loss, blunder: P.blunder_loss });
  const cost = v === "best" || v === "good" ? "" : ` −${(j.loss / 100).toFixed(1)}`;
  return `<span class="tag ${v}" title="Stockfish: ${j.best ? "its own choice" : `gives away about ${(j.loss / 100).toFixed(1)} pawns against ${esc(j.bestSan)}`}">${WORD[v]}${cost}</span>`;
}

/** "e5" for a UCI move from a position. */
function sanOf(fen, uci) {
  try { return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san; } catch { return null; }
}

/** The engine's best move and eval in a position (one search per position, shared). */
function bestOf(nd) {
  if (!state.bests.has(nd)) state.bests.set(nd, state.evaluate(nd.fen, P.slip_depth, 1).then(([b]) => ({ ...b, san: b?.move ? sanOf(nd.fen, b.move) : null })));
  return state.bests.get(nd);
}

/** Judge one move: what it gives away against the engine's best from the position it was played in. */
async function judge(k) {
  if (state.judged.has(k)) return state.judged.get(k);
  const run = state.run, nd = k.parent, best = await bestOf(nd);
  if (!best?.move) return null;
  let j;
  if (best.san === k.san) j = { loss: 0, best: true, bestSan: best.san };
  else {
    const [after] = await state.evaluate(k.fen, P.slip_depth, 1);
    if (!after) return null;   // mate or stalemate on the board: nothing to search
    const sign = nd.fen.split(" ")[1] === "w" ? 1 : -1;
    j = { loss: Math.max(0, sign * (best.cp - after.cp)), best: false, bestSan: best.san };
  }
  if (state.run === run) state.judged.set(k, j);
  return j;
}

/** In the explorer, every move shown gets a verdict as soon as it's open (cached, so revisits are instant). */
async function judgeHere(nd) {
  if (!state.evaluate || !nd.kids.size) return;
  const run = state.run;
  await Promise.all([...nd.kids.values()].map((k) => judge(k).catch(() => null)));
  if (state.run === run && state.node === nd && !$("pane-tree").hidden) goTo(nd, { judge: false });
}

/**
 * Stockfish on their moves: every move they made at least exploit_min_games times (most played first, capped), and
 * their habits. A move that gives away slip_loss or more becomes a game plan.
 */
async function checkMoves(run) {
  try {
    if (!pool) {
      const engines = await Promise.all(Array.from({ length: poolSize() }, () =>
        new UciEngine(workerTransport(ENGINE_URL), { mateScore: cfg.engine.mate_score }).init({ Hash: 16 })));
      pool = new EnginePool(engines);
    }
  } catch { state.plans = []; paintPlans("Stockfish didn't start in this browser, so their moves can't be checked."); return; }
  state.evaluate = new Evaluator({ store, pool }).forGame();
  const list = [...new Set([...theirMoves(state.tree, state.theirs, { minGames: P.exploit_min_games, max: P.move_check_max }),
    ...state.habits.map((h) => h.move)])];
  state.check = { done: 0, all: list.length };
  $("note").textContent = `Checking their moves with Stockfish… 0/${list.length}`;
  goTo(state.node);
  paintPlans();
  await Promise.all(list.map(async (k) => {
    try { await judge(k); } catch {}
    if (state.run !== run) return;
    $("note").textContent = `Checking their moves with Stockfish… ${++state.check.done}/${list.length}`;
    paintPlans();
  }));
  if (state.run !== run) return;
  const slips = list.filter((k) => (state.judged.get(k)?.loss ?? 0) >= P.slip_loss);
  $("note").textContent = `Checked ${list.length} of their moves: ${slips.length} give${slips.length === 1 ? "s" : ""} something away.`;
  paintHabits();
  if (!$("pane-tree").hidden) goTo(state.node);
  await buildPlans(run, slips);
}


// ---------- game plans: the full line against a costly move ----------

/** Their costly moves as plans, best bets first, each with the engine's punishing line once it's worked out. */
async function buildPlans(run, slips) {
  state.plans = rankPlans(slips.map((k) => ({ node: k.parent, move: k, loss: state.judged.get(k).loss })), state.theirs,
    { lossCap: P.plan_loss_cap }).slice(0, P.plan_max);
  paintPlans();
  await Promise.all(state.plans.map(async (p) => {
    let line = null;
    try { [line] = await pool.analyse(p.move.fen, P.plan_depth, 1, true); } catch {}
    if (state.run !== run) return;
    try { p.w = refutation({ before: p.node.fen, habit: p.move.san, line }); } catch { p.w = null; }
    p.ready = true;
    if (!state.plan) paintPlans();
  }));
  if (state.run === run && !state.plan) paintPlans();
  if (state.run === run && !$("pane-tree").hidden) goTo(state.node, { judge: false });
}

/** "3…Bg4" for the move that led to a node. */
const moveText = (nd) => `${Math.ceil(nd.ply / 2)}${nd.ply % 2 ? "." : "…"}${nd.san}`;

/** The plan tab: the list of plans, or the open one. */
function paintPlans(error = null) {
  if (state.plan) return;
  const { plans, username, mine } = state, pane = $("pane-plan");
  const intro = `<p class="pane-intro">Moves ${esc(username)} has made at least ${P.exploit_min_games} times that give something away, best bets first: ` +
    `how likely they are to walk into it, times what it costs. Each plan is the full line as ${COLOR[mine]}: your moves to get there, their move, and how to punish it.</p>`;
  if (error) { pane.innerHTML = intro + `<p class="empty">${esc(error)}</p>`; return; }
  if (!plans) {
    pane.innerHTML = intro + `<p class="walk-wait">Checking their moves with Stockfish…${state.check ? ` ${state.check.done}/${state.check.all}` : ""}</p>`;
    return;
  }
  if (!plans.length) {
    pane.innerHTML = intro + `<p class="empty">None of the moves they make often gives anything away. ` +
      `The Weak spots tab has the lines where they do badly anyway.</p>`;
    return;
  }
  pane.innerHTML = intro + `<ol class="rows">` + plans.map((p, i) => `<li><button type="button" class="row" data-plan="${i}">
      <span class="row-main"><b class="mono">${esc(moveText(p.move))}?</b><span class="row-name">${esc(numberLine(lineOf(p.node)) || "From the first move")}${p.node.name ? ` · ${esc(family(p.node.name))}` : ""}</span></span>
      <span class="row-side"><span class="tag slip">Costs ${(p.loss / 100).toFixed(1)}</span><span class="label" title="The chance they follow this road and play the habit, from their games">${pct(p.odds)} fall for it</span></span></button></li>`).join("") + `</ol>`;
  pane.onclick = (e) => { const b = e.target.closest("button.row"); if (b && plans[+b.dataset.plan].ready) openPlan(+b.dataset.plan); };
  pane.querySelectorAll("button.row").forEach((b) => { if (!plans[+b.dataset.plan].ready) b.querySelector(".row-side .label").textContent = "Working it out…"; });
}

/**
 * One plan: the road there (your moves, and how often they follow with theirs), then their habit and your punishment,
 * stepped on the board a move at a time. The board shows the next move as an arrow, so you see what's coming.
 */
function openPlan(i) {
  const p = state.plans[i];
  if (!p?.ready) return;
  state.plan = null;
  selectTab("plan");
  const { username, mine } = state, pane = $("pane-plan");
  const roadSteps = p.steps.slice(0, -1);
  // frames: the start, each road move, their habit, then the punishing line
  const frames = [{ fen: p.steps[0]?.node.parent.fen ?? p.node.fen, move: null }];
  for (const s of p.steps) frames.push({ fen: s.node.fen, move: { from: s.node.uci.slice(0, 2), to: s.node.uci.slice(2, 4) }, color: s.node.parent.fen.split(" ")[1] });
  const habitAt = frames.length - 1;
  const w = p.w;
  for (const st of w?.steps.slice(1) || []) frames.push({ fen: st.ply.after, move: { from: st.ply.move.from, to: st.ply.move.to }, color: st.ply.move.color });

  const chips = roadSteps.map((s, k) => `<button type="button" class="crumb ${s.theirs ? "theirs" : "yours"}" data-f="${k + 1}"` +
    ` title="${s.theirs ? `${esc(username)} played this in ${s.node.n} of ${s.node.parent.n} games here` : "Your move"}">` +
    `${s.node.ply % 2 ? `${(s.node.ply + 1) / 2}.` : ""}${esc(s.node.san)}` +
    (s.theirs ? `<small>${pct(s.share)}</small>` : "") + `</button>`).join("");
  const rows = (w?.steps || []).map((st, k) =>
    `<li><button type="button" data-f="${habitAt + k}"><b>${esc(numbered(st.ply.before, st.ply.move))}</b><span>${st.text}</span></button></li>`).join("");
  // Where they can leave the road: at each of their moves on it, what else they've played (and how often).
  const off = roadSteps.filter((s) => s.theirs && s.share < 1).flatMap((s) =>
    kidsOf(s.node.parent).filter((k) => k !== s.node).slice(0, 2).map((k) => ({ k, of: s.node.parent.n })));
  const offHtml = off.length ? `<p class="off label">Where they can go another way: ` + off.map(({ k, of }, j) =>
    `<button type="button" class="link-btn" data-off="${j}" title="Open in the explorer">${esc(moveText(k))}</button> ${k.n} of ${of}`).join(" · ") + `</p>` : "";
  const links = p.move.links.slice(0, 3).map((l, k) => `<a href="${esc(l)}" target="_blank" rel="noopener">Game ${k + 1} ↗</a>`).join("");
  const yourMoves = roadSteps.filter((s) => !s.theirs).length;
  pane.innerHTML =
    `<button type="button" class="link-btn plan-back">← All plans</button>` +
    `<p class="opening"><span class="label">${esc(p.node.eco || "")}</span> Punish ${esc(moveText(p.move))}</p>` +
    `<p class="pane-intro">${roadSteps.length ? `${yourMoves ? `Play the highlighted ${yourMoves === 1 ? "move" : "moves"}` : "Wait for it"}; ` +
      `${esc(username)} has gone this way about ${pct(p.odds / (p.move.n / p.node.n))} of the time. ` : ""}` +
      `Once there, they played <b>${esc(p.move.san)}</b> in ${p.move.n} of ${p.node.n} games, and it costs them about ${(p.loss / 100).toFixed(1)} pawns.</p>` +
    (roadSteps.length ? `<div class="road"><span class="label">The road</span><nav class="crumbs">${chips}</nav>${offHtml}</div>` : "") +
    `<div class="walk plan-walk"><p class="label">The punishment</p><ol class="walk-steps">${rows}</ol>` +
      (w?.summary ? `<p class="walk-sum">${esc(w.summary)}</p>` : "") +
      `<button class="btn ghost walk-step" type="button"></button></div>` +
    (links ? `<p class="links label">Their games that went this way: ${links}</p>` : "") +
    `<button type="button" class="link-btn plan-tree">Open in the explorer</button>`;
  const step = pane.querySelector(".walk-step");
  const show = (f) => {
    plan.at = f;
    const fr = frames[f], next = frames[f + 1];
    const arrows = next ? [{ from: next.move.from, to: next.move.to, weight: 1, kind: next.color === mine ? "yours" : "theirs" }] : [];
    board.draw(fr.fen, { last: fr.move, arrows });
    pane.querySelectorAll("[data-f]").forEach((b) => b.closest("li, .crumb")?.classList.toggle("on", +b.dataset.f === f));
    step.innerHTML = f < frames.length - 1 ? `Next move <svg class="icon"><use href="#i-next"/></svg>`
      : `<svg class="icon"><use href="#i-replay"/></svg>From the start`;
  };
  const plan = state.plan = { i, at: habitAt - 1, show };
  pane.onclick = (e) => {
    if (e.target.closest(".plan-back")) { state.plan = null; paintPlans(); goTo(state.node); return; }
    if (e.target.closest(".plan-tree")) { state.plan = null; paintPlans(); openInTree(p.node); return; }
    const o = e.target.closest("[data-off]");
    if (o) { state.plan = null; paintPlans(); openInTree(off[+o.dataset.off].k); return; }
    const b = e.target.closest("[data-f]");
    if (b) show(+b.dataset.f);
    else if (e.target.closest(".walk-step")) show(plan.at < frames.length - 1 ? plan.at + 1 : 0);
  };
  pane.scrollTop = 0;
  show(plan.at);
}

const TABS = ["plan", "weak", "tree", "habits"];

function selectTab(name) {
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
  // The board belongs to the open plan on the plan tab, and to the explorer everywhere else.
  if (name === "plan" && state?.plan) state.plan.show(state.plan.at);
  else if (state?.tree) goTo(state.node);
}

async function main() {
  setupTheme();
  const range = new Select($("range")), siteSel = new Select($("site")), site2Sel = new Select($("site2"));
  fitHero();
  document.fonts?.ready.then(fitHero);
  new ResizeObserver(fitHero).observe(document.querySelector(".stage"));
  board = new Board($("board"), $("arrows"));
  store = await openStore();

  const paintSite = () => {
    const site = $("site").value;
    $("username-label").textContent = `Their ${SITE_NAME[site]} username`;
    document.querySelector("input[name=tc][value=daily] + span").lastChild.textContent = site === "lichess" ? "Corresp." : "Daily";
  };
  $("site").addEventListener("change", paintSite);
  // Their other account: a second site and username, pooled with the first.
  const paintSite2 = () => { $("username2-label").textContent = `Their ${SITE_NAME[$("site2").value]} username`; };
  const showAlso = (on) => {
    $("also").hidden = !on;
    $("btn-also").hidden = on;
    $("range-label").textContent = on ? "Games, each" : "Games";
    if (!on) $("username2").value = "";
  };
  $("site2").addEventListener("change", paintSite2);
  $("btn-also").addEventListener("click", () => {
    $("site2").value = $("site").value === "lichess" ? "chesscom" : "lichess";
    site2Sel.sync();
    paintSite2();
    showAlso(true);
    $("username2").focus();
  });
  $("btn-also-remove").addEventListener("click", () => { showAlso(false); $("btn-also").focus(); });
  const last = (await store.get("scout-last")) ?? (await store.get("prep-last"));   // the page was called Prep before
  if (last) {
    $("site").value = last.site === "lichess" ? "lichess" : "chesscom";
    siteSel.sync();
    $("username").value = last.username;
    if (last.also) {
      $("site2").value = last.also.site === "lichess" ? "lichess" : "chesscom";
      site2Sel.sync();
      paintSite2();
      showAlso(true);
      $("username2").value = last.also.username;
    }
    if ([...$("range").options].some((o) => o.value === last.range)) { $("range").value = last.range; range.sync(); }
    for (const box of document.querySelectorAll("input[name=tc]")) box.checked = last.timeClasses.includes(box.value);
    const side = document.querySelector(`input[name=side][value="${last.side}"]`);
    if (side) side.checked = true;
  } else {
    // A bigger sample by default: a player's openings need more games than their blunders.
    $("range").value = "g200";
    range.sync();
    for (const box of document.querySelectorAll("input[name=tc]")) box.checked = box.value !== "daily";
  }
  paintSite();

  for (const t of TABS) $(`tab-${t}`).addEventListener("click", () => selectTab(t));
  document.querySelector(".tabs").addEventListener("keydown", (e) => {   // ← → between tabs, as tab lists do
    const tabs = [...document.querySelectorAll("[role=tab]")], i = tabs.indexOf(document.activeElement);
    if (i < 0 || !["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
  $("btn-change").addEventListener("click", () => { $("start").classList.add("open"); $("username").focus(); });
  $("start").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = $("username").value.trim();
    if (!username) return;
    const timeClasses = [...document.querySelectorAll("input[name=tc]:checked")].map((b) => b.value);
    const accounts = [{ site: $("site").value, username }];
    const other = $("username2").value.trim();
    if (!$("also").hidden && other) accounts.push({ site: $("site2").value, username: other });
    analyze(accounts, $("range").value, timeClasses, sideNow());
  });
}

main();
