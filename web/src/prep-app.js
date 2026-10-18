// Match prep page: an opponent's username -> their finished games -> their opening tree -> weak spots, an explorer
// of what they play, their habits checked with Stockfish, and game plans: full lines that punish the costly ones. Fair play: finished games only, as in the drill.

import { Chess } from "chess.js";
import { Board } from "./board.js";
import { ChessCom } from "./chesscom.js";
import { EnginePool, Evaluator } from "./evals.js";
import { numbered, refutation } from "./explain.js";
import { Lichess } from "./lichess.js";
import { buildTree, byFamily, bookExit, family, habits, kidsOf, lineOf, numberLine, predictability, rankPlans, walk, weakSpots } from "./prep.js";
import { Select } from "./select.js";
import { IdbStore, MemoryStore } from "./store.js";
import { UciEngine } from "./uci.js";
import { fitHero, poolSize, setupTheme, workerTransport } from "./ui.js";

const cfg = await (await fetch(new URL("./config.json", import.meta.url))).json();
const P = cfg.prep;
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
let state = null;   // {tree, mine, theirs, username, site, node, slips: Map(node -> verdict), plans, plan, run}

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

async function analyze(site, username, rangeValue, timeClasses, mine) {
  const run = {};
  state = { run };
  const theirs = mine === "w" ? "b" : "w";
  $("error").hidden = true;
  $("report").hidden = true;
  document.body.dataset.view = "loading";
  setStatus(`Fetching ${username}'s finished games from ${SITE_NAME[site]}…`, 0.1);
  let games;
  try {
    names ??= await (await fetch(new URL("./openings.json", import.meta.url))).json();
    games = site === "lichess"
      ? await new Lichess({ store }).games(username, { range: parseRange(rangeValue), timeClasses,
          onProgress: (n) => setStatus(`Fetching ${username}'s finished games from Lichess… ${n}`, 0.1) })
      : await new ChessCom({ store, minInterval: cfg.fetch.min_interval }).games(username, { range: parseRange(rangeValue), timeClasses });
  } catch (e) {
    if (state.run !== run) return;
    setStatus("");
    $("error").textContent = e.message;
    $("error").hidden = false;
    document.body.dataset.view = "intro";
    return;
  }
  if (state.run !== run) return;
  const theirGames = games.filter((g) => g.color === theirs);
  if (!theirGames.length) {
    setStatus("");
    $("error").textContent = `No finished ${timeClasses.join("/") || ""} games where ${username} had ${COLOR[theirs]}. Try a longer range or more time controls.`;
    $("error").hidden = false;
    document.body.dataset.view = "intro";
    return;
  }
  await store.set("prep-last", { site, username, range: rangeValue, timeClasses, side: mine });
  const tree = buildTree(theirGames, { plies: P.plies, names });
  Object.assign(state, { tree, mine, theirs, username, site, node: tree.root, slips: new Map(), plans: null, plan: null });
  setStatus("");
  board.white = mine === "w";
  $("who").textContent = `${username}${site === "lichess" ? " (Lichess)" : ""} as ${COLOR[theirs]} · ${theirGames.length} games`;
  $("start").classList.remove("open");
  document.body.dataset.view = "report";
  $("report").hidden = false;
  paintSummary();
  paintWeak();
  paintHabits();
  goTo(tree.root);
  selectTab("plan");
  paintPlans();
  checkHabits(run);
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
function goTo(nd) {
  state.node = nd;
  const { theirs, username } = state;
  const kids = kidsOf(nd), theirTurn = nd.fen.split(" ")[1] === theirs;
  const path = [];
  for (let x = nd; x; x = x.parent) path.unshift(x);
  const crumbs = path.map((x, i) => i === 0
    ? `<button type="button" class="crumb" data-ply="0">Start</button>`
    : `<button type="button" class="crumb" data-ply="${i}">${i % 2 === 1 ? `${(i + 1) / 2}.` : ""}${esc(x.san)}</button>`).join("");
  const total = kids.reduce((s, k) => s + k.n, 0);
  const slip = state.slips.get(nd);
  const rows = kids.map((k) => `<li><button type="button" class="row" data-san="${esc(k.san)}">
      <span class="row-main"><b class="mono">${esc(k.san)}</b><span class="row-name">${k.name && k.name !== nd.name ? `${esc(k.name)} · ` : ""}they won ${pct(won(k))}</span></span>
      <span class="row-side"><b>${pct(k.n / total)}</b><span class="label">played · ${games(k.n)}</span></span>${wdl(k)}</button></li>`).join("");
  const links = nd.links.slice(0, 3).map((l, i) => `<a href="${esc(l)}" target="_blank" rel="noopener">Game ${i + 1} ↗</a>`).join("");
  $("pane-tree").innerHTML =
    `<nav class="crumbs" aria-label="Line">${crumbs}</nav>` +
    `<p class="opening"><span class="label">${esc(nd.eco || "")}</span> ${esc(nd.name || "Starting position")}</p>` +
    `<p class="pane-intro">${nd.n === 1 ? "One of their games" : `${nd.n} of their games`} reached this. ` +
      (kids.length ? (theirTurn ? `<b>${esc(username)}</b> to move: what they played here.` : `Your move: what their opponents played, and how ${esc(username)} did.`)
        : "Their games go different ways from here.") + `</p>` +
    (slip ? `<p class="slip-note"><b>Habit check:</b> ${slip.text}` +
      (state.plans?.some((p) => p.node === nd && p.w) ? ` <button type="button" class="link-btn" data-plan-of>See the game plan</button>` : "") + `</p>` : "") +
    (kids.length ? `<ol class="rows">${rows}</ol>` : "") +
    (links ? `<p class="links label">Their latest games here: ${links}</p>` : "");
  $("pane-tree").onclick = (e) => {
    const c = e.target.closest(".crumb");
    if (c) return goTo(path[+c.dataset.ply]);
    if (e.target.closest("[data-plan-of]")) return openPlan(state.plans.findIndex((p) => p.node === nd));
    const r = e.target.closest("button.row");
    if (r) goTo(nd.kids.get(r.dataset.san));
  };
  // Board: the position, the move that led here, and arrows for the moves played next (heavier = more often).
  const arrows = kids.slice(0, 4).map((k) => ({ from: k.uci.slice(0, 2), to: k.uci.slice(2, 4), weight: k.n / total, kind: theirTurn ? "theirs" : "yours" }));
  const last = nd.uci ? { from: nd.uci.slice(0, 2), to: nd.uci.slice(2, 4) } : null;
  board.draw(nd.fen, { last, arrows });
}

/** Their habits (the same move most of the time), with the engine's verdict once checked. */
function paintHabits() {
  const { tree, theirs, username } = state;
  const list = habits(tree, theirs, { minGames: P.habit_min_games, minShare: P.habit_min_share });
  state.habits = list;
  const verdict = (h) => {
    const v = state.slips.get(h.node);
    if (!v) return `<span class="label">Checking…</span>`;
    return v.slip ? `<span class="tag slip">Costs ${v.loss}</span>` : `<span class="label">Fine</span>`;
  };
  const sorted = [...list].sort((a, b) => (state.slips.get(b.node)?.slip ? 1 : 0) - (state.slips.get(a.node)?.slip ? 1 : 0));
  $("pane-habits").innerHTML =
    `<p class="pane-intro">Positions ${esc(username)} reached at least ${P.habit_min_games} times and answered the same way most of the time. ` +
      `Stockfish checks each: a habit that costs them is something to aim for.</p>` +
    (sorted.length ? `<ol class="rows">` + sorted.map((h) => `<li><button type="button" class="row" data-i="${list.indexOf(h)}">
      <span class="row-main"><b class="mono">${esc(numberLine(lineOf(h.move)).split(" ").slice(-2).join(" "))}</b><span class="row-name">${esc(lineText(h.node))}</span></span>
      <span class="row-side">${verdict(h)}<span class="label">${h.move.n} of ${h.node.n}</span></span></button></li>`).join("") + `</ol>`
      : `<p class="empty">No repeated choices yet. More games may show some.</p>`);
  $("pane-habits").onclick = (e) => { const b = e.target.closest("button.row"); if (b) openInTree(list[+b.dataset.i].node); };
}

/** Stockfish on their habits, most played first: how much their usual move gives away against the best move. */
async function checkHabits(run) {
  const list = state.habits.slice(0, P.slip_max);
  if (!list.length) { state.plans = []; paintPlans(); return; }
  try {
    if (!pool) {
      const engines = await Promise.all(Array.from({ length: poolSize() }, () =>
        new UciEngine(workerTransport(ENGINE_URL), { mateScore: cfg.engine.mate_score }).init({ Hash: 16 })));
      pool = new EnginePool(engines);
    }
  } catch { state.plans = []; paintPlans("Stockfish didn't start in this browser, so their habits can't be checked."); return; }
  const evaluate = new Evaluator({ store, pool }).forGame();
  const sign = state.theirs === "w" ? 1 : -1;
  let done = 0;
  $("note").textContent = `Checking their habits with Stockfish… 0/${list.length}`;
  await Promise.all(list.map(async (h) => {
    const [best] = await evaluate(h.node.fen, P.slip_depth, 1);
    const [after] = await evaluate(h.move.fen, P.slip_depth, 1);
    if (state.run !== run) return;
    const loss = Math.max(0, sign * (best.cp - after.cp));
    const bestSan = best.move ? new Chess(h.node.fen).move({ from: best.move.slice(0, 2), to: best.move.slice(2, 4), promotion: best.move[4] }).san : null;
    const pawns = (loss / 100).toFixed(1);
    const slip = loss >= P.slip_loss && bestSan !== h.move.san;
    state.slips.set(h.node, { slip, loss: pawns, cp: loss, bestSan, text: slip
      ? `${esc(state.username)} plays <b>${esc(h.move.san)}</b> here ${h.move.n} of ${h.node.n} times. Stockfish: it gives away about ${pawns} pawns; <b>${esc(bestSan)}</b> is best.`
      : `${esc(state.username)} usually plays <b>${esc(h.move.san)}</b> here (${h.move.n} of ${h.node.n}), and Stockfish agrees it's fine.` });
    $("note").textContent = `Checking their habits with Stockfish… ${++done}/${list.length}`;
    paintPlans();
  }));
  if (state.run !== run) return;
  const slips = [...state.slips.values()].filter((v) => v.slip).length;
  $("note").textContent = `Habits checked: ${slips} cost${slips === 1 ? "s" : ""} them something.`;
  paintHabits();
  goTo(state.node);
  await buildPlans(run);
}


// ---------- game plans: the full line against a costly habit ----------

/** The costly habits as plans, best bets first, each with the engine's punishing line once it's worked out. */
async function buildPlans(run) {
  const slips = state.habits.filter((h) => state.slips.get(h.node)?.slip)
    .map((h) => ({ node: h.node, move: h.move, loss: state.slips.get(h.node).cp }));
  state.plans = rankPlans(slips, state.theirs, { lossCap: P.plan_loss_cap }).slice(0, P.plan_max);
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
}

/** "3…Bg4" for the move that led to a node. */
const moveText = (nd) => `${Math.ceil(nd.ply / 2)}${nd.ply % 2 ? "." : "…"}${nd.san}`;

/** The plan tab: the list of plans, or the open one. */
function paintPlans(error = null) {
  if (state.plan) return;
  const { plans, username, mine } = state, pane = $("pane-plan");
  const intro = `<p class="pane-intro">Lines where a habit of ${esc(username)}'s costs them, best bets first: how likely they are to walk into it, ` +
    `times what it costs. Each plan is the full line as ${COLOR[mine]}: your moves to get there, their habit, and how to punish it.</p>`;
  if (error) { pane.innerHTML = intro + `<p class="empty">${esc(error)}</p>`; return; }
  if (!plans) {
    const checked = [...state.slips.keys()].length, all = Math.min(state.habits?.length ?? 0, P.slip_max);
    pane.innerHTML = intro + `<p class="walk-wait">Checking their habits with Stockfish… ${checked}/${all}</p>`;
    return;
  }
  if (!plans.length) {
    pane.innerHTML = intro + `<p class="empty">None of their habits${state.habits.length ? "" : " (none found yet)"} gives anything away. ` +
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
  const range = new Select($("range")), siteSel = new Select($("site"));
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
  const last = await store.get("prep-last");
  if (last) {
    $("site").value = last.site === "lichess" ? "lichess" : "chesscom";
    siteSel.sync();
    $("username").value = last.username;
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
    analyze($("site").value, username, $("range").value, timeClasses, sideNow());
  });
}

main();
