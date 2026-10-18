// Match prep page: an opponent's username -> their finished games -> their opening tree -> weak spots, an explorer
// of what they play, and their habits checked with Stockfish. Fair play: finished games only, as in the drill.

import { Chess } from "chess.js";
import { Board } from "./board.js";
import { ChessCom } from "./chesscom.js";
import { EnginePool, Evaluator } from "./evals.js";
import { Lichess } from "./lichess.js";
import { buildTree, byFamily, bookExit, family, habits, kidsOf, lineOf, numberLine, predictability, score, walk, weakSpots } from "./prep.js";
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

let names = null, store = null, pool = null, board = null;
let state = null;   // {tree, mine, theirs, username, site, node, slips: Map(node -> verdict), run}

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
  Object.assign(state, { tree, mine, theirs, username, site, node: tree.root, slips: new Map() });
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
  checkHabits(run);
}

function paintSummary() {
  const { tree, theirs } = state;
  $("r-games").textContent = tree.games;
  $("r-score").textContent = pct(score(tree.root));
  $("r-pred").textContent = pct(predictability(tree, theirs));
  const exit = bookExit(tree);
  $("r-book").textContent = exit ? `Move ${exit}` : "–";
}

/** Weak spots, then their results by opening. Each row opens that line in the explorer. */
function paintWeak() {
  const { tree, theirs, mine, username } = state;
  const spots = weakSpots(tree, theirs, { minGames: P.min_games, gap: P.weak_gap, max: P.weak_spots });
  const fams = byFamily(tree, { minGames: P.family_min_games });
  const overall = score(tree.root);
  const rows = spots.map((s, i) => `<li><button type="button" class="row" data-weak="${i}">
      <span class="row-main"><b class="mono">${esc(lineText(s.node))}</b><span class="row-name">${esc(s.node.name || "Unnamed line")}</span></span>
      <span class="row-side"><b>${pct(score(s.node))}</b><span class="label">${games(s.node.n)}</span></span>${wdl(s.node)}</button></li>`).join("");
  $("pane-weak").innerHTML =
    `<p class="pane-intro">Lines you can steer into as ${COLOR[mine]} where ${esc(username)} scores well below their usual ${pct(overall)}.</p>` +
    (spots.length ? `<ol class="rows">${rows}</ol>`
      : `<p class="empty">No line with ${P.min_games}+ games where they do clearly worse. More games (a longer range or more time controls) may show some.</p>`) +
    (fams.length ? `<h3 class="label pane-head">By opening</h3><ol class="rows fams">` + fams.map((f, i) => `<li><button type="button" class="row" data-fam="${i}">
      <span class="row-main"><span class="row-name">${esc(f.family)}</span><span class="label">${esc(f.eco)}</span></span>
      <span class="row-side"><b>${pct(f.score)}</b><span class="label">${games(f.n)}</span></span>${wdl(f)}</button></li>`).join("") + `</ol>` : "");
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
      <span class="row-main"><b class="mono">${esc(k.san)}</b><span class="row-name">${k.name && k.name !== nd.name ? esc(k.name) : ""}</span></span>
      <span class="row-side"><b>${pct(k.n / total)}</b><span class="label">${games(k.n)}</span></span>${wdl(k)}</button></li>`).join("");
  const links = nd.links.slice(0, 3).map((l, i) => `<a href="${esc(l)}" target="_blank" rel="noopener">Game ${i + 1} ↗</a>`).join("");
  $("pane-tree").innerHTML =
    `<nav class="crumbs" aria-label="Line">${crumbs}</nav>` +
    `<p class="opening"><span class="label">${esc(nd.eco || "")}</span> ${esc(nd.name || "Starting position")}</p>` +
    `<p class="pane-intro">${nd.n === 1 ? "One of their games" : `${nd.n} of their games`} reached this. ` +
      (kids.length ? (theirTurn ? `<b>${esc(username)}</b> to move: what they played here.` : `Your move: what their opponents played, and how ${esc(username)} did.`)
        : "Their games go different ways from here.") + `</p>` +
    (slip ? `<p class="slip-note"><b>Habit check:</b> ${slip.text}</p>` : "") +
    (kids.length ? `<ol class="rows">${rows}</ol>` : "") +
    (links ? `<p class="links label">Their latest games here: ${links}</p>` : "");
  $("pane-tree").onclick = (e) => {
    const c = e.target.closest(".crumb");
    if (c) return goTo(path[+c.dataset.ply]);
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
  if (!list.length) return;
  try {
    if (!pool) {
      const engines = await Promise.all(Array.from({ length: poolSize() }, () =>
        new UciEngine(workerTransport(ENGINE_URL), { mateScore: cfg.engine.mate_score }).init({ Hash: 16 })));
      pool = new EnginePool(engines);
    }
  } catch { return; }
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
    state.slips.set(h.node, { slip, loss: pawns, text: slip
      ? `${esc(state.username)} plays <b>${esc(h.move.san)}</b> here ${h.move.n} of ${h.node.n} times. Stockfish: it gives away about ${pawns} pawns; <b>${esc(bestSan)}</b> is best.`
      : `${esc(state.username)} usually plays <b>${esc(h.move.san)}</b> here (${h.move.n} of ${h.node.n}), and Stockfish agrees it's fine.` });
    $("note").textContent = `Checking their habits with Stockfish… ${++done}/${list.length}`;
  }));
  if (state.run !== run) return;
  const slips = [...state.slips.values()].filter((v) => v.slip).length;
  $("note").textContent = `Habits checked: ${slips} cost${slips === 1 ? "s" : ""} them something.`;
  paintHabits();
  goTo(state.node);
}

function selectTab(name) {
  for (const t of ["weak", "tree", "habits"]) {
    $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    $(`pane-${t}`).hidden = t !== name;
  }
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

  for (const t of ["weak", "tree", "habits"]) $(`tab-${t}`).addEventListener("click", () => selectTab(t));
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
