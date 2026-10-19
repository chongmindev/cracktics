// Wires the page: username -> Chess.com or Lichess games -> scan (cache, Lichess cloud, engine pool) -> trainer.

import { ChessCom } from "./chesscom.js";
import { Lichess } from "./lichess.js";
import { EnginePool, Evaluator } from "./evals.js";
import { Scan } from "./scan.js";
import { Select } from "./select.js";
import { sound } from "./sound.js";
import { IdbStore, MemoryStore } from "./store.js";
import { Trainer } from "./trainer.js";
import { UciEngine } from "./uci.js";
import { fitHero, poolSize, setupTheme, workerTransport } from "./ui.js";

// JSON modules (import ... with {type: "json"}) are too new for some browsers still in use.
const cfg = await (await fetch(new URL("./config.json", import.meta.url))).json();
const ENGINE_URL = "engine/stockfish-19-lite-single.js";
const $ = (id) => document.getElementById(id);
const SITE_NAME = { chesscom: "Chess.com", lichess: "Lichess" };

/** Progress and scan results are kept per player and site (Chess.com keeps its original, unprefixed keys). */
const playerKey = (site, username) => (site === "lichess" ? "lichess:" : "") + username.toLowerCase();
const siteNow = () => $("site").value || "chesscom";

/** The status readout's mark follows the scan: idle, fetching, scanning, ready, error. */
function setState(state) {
  $("status-led").dataset.state = state;
}





function setupSound() {
  const btn = $("btn-sound");
  const paint = () => {
    btn.setAttribute("aria-pressed", String(sound.on));
    btn.title = sound.on ? "Sound on" : "Sound off";
    btn.setAttribute("aria-label", btn.title);
  };
  btn.addEventListener("click", () => { sound.set(!sound.on); paint(); if (sound.on) sound.play("right"); });
  paint();
}

async function openStore() {
  try { return await IdbStore.open(); } catch { return new MemoryStore(); }
}

let scan = null, pool = null;

/** Range select value -> ChessCom range: g50 = newest 50 games, d30 = past 30 days, all = every archive. */
export function parseRange(value) {
  if (value === "all") return { all: true };
  const n = Number(value.slice(1));
  return value[0] === "g" ? { games: n } : { days: n };
}

async function start(store, trainer, site, username, rangeValue, timeClasses) {
  const range = parseRange(rangeValue);
  const rangeLabel = $("range").selectedOptions[0]?.textContent.toLowerCase() || rangeValue;
  scan?.stop();
  $("status").hidden = false;
  setState("fetching");
  $("status-text").textContent = `Fetching your finished games from ${SITE_NAME[site]}…`;
  $("error").hidden = true;
  let games;
  try {
    games = site === "lichess"
      ? await new Lichess({ store }).games(username, { range, timeClasses,
          onProgress: (n) => { $("status-text").textContent = `Fetching your finished games from Lichess… ${n}`; } })
      : await new ChessCom({ store, minInterval: cfg.fetch.min_interval }).games(username, { range, timeClasses });
  } catch (e) {
    $("error").textContent = e.message;
    $("error").hidden = false;
    $("status").hidden = true;
    setState("error");
    return;
  }
  if (!games.length) {
    $("status-text").textContent = `No finished ${timeClasses.join("/") || ""} games (${rangeLabel}).`;
    setState("idle");
    return;
  }
  await store.set("last", { site, username, range: rangeValue, timeClasses });
  $("who").textContent = `${username}${site === "lichess" ? " (Lichess)" : ""} · ${timeClasses.join(", ") || "all"} · ${rangeLabel} · ${games.length} games`;
  $("start").classList.remove("open");
  document.body.dataset.view = "waiting";

  if (!pool) {
    const engines = await Promise.all(Array.from({ length: poolSize() }, () =>
      new UciEngine(workerTransport(ENGINE_URL), { mateScore: cfg.engine.mate_score }).init({ Hash: 16 })));
    pool = new EnginePool(engines);
  }
  // The Lichess cloud is off: measured slower than local engines (docs/decisions.md). Pass a LichessCloud to enable.
  const evaluator = new Evaluator({ store, pool, cloud: null });
  // A move outside the accepted list is judged by the same engines (and cache).
  trainer.evaluate = async (fen) => (await evaluator.forGame()(fen, cfg.drills.depth, 1))[0];
  // Explanations want the engine's whole line, which the cache doesn't keep: a fresh search, one position.
  trainer.analyse = (fen) => pool.analyse(fen, cfg.drills.depth, 1, true);
  const key = `progress|${playerKey(site, username)}`;
  trainer.key = key;
  trainer.load = () => store.get(key);
  trainer.save = (p) => store.set(key, p);
  await trainer.start();

  const t0 = Date.now();
  scan = new Scan({ username: playerKey(site, username), games, evaluator, store, cfg, concurrency: pool.size, onUpdate: (u) => {
    setState(u.running ? "scanning" : "ready");
    // Quick pass fills the first 60% of the meter, the deep pass the rest.
    const frac = u.total ? u.done / u.total : 1;
    $("bar").style.width = `${Math.round(100 * (u.phase === 1 ? 0.6 * frac : 0.6 + 0.4 * frac))}%`;
    const secs = Math.round((Date.now() - t0) / 1000);
    const pass = u.phase === 1 ? "Quick pass" : "Deep pass";
    $("status-text").textContent = u.running
      ? `${pass} · ${u.done}/${u.total} games · ${u.deck.length} positions · ${secs}s`
      : `${u.total} games · ${u.deck.length} mistakes to replay`;
    document.body.dataset.view = u.deck.length ? "drill" : "waiting";
    trainer.setItems(u.deck);
  } });
  await scan.run();
}

async function main() {
  setupTheme();
  setupSound();
  const range = new Select($("range")), siteSel = new Select($("site"));
  fitHero();
  document.fonts?.ready.then(fitHero);
  new ResizeObserver(fitHero).observe(document.querySelector(".stage"));
  const store = await openStore();
  const trainer = new Trainer({
    board: $("board"), arrows: $("arrows"), pop: $("pop"), meta: $("meta"), step: $("step"), question: $("question"), context: $("context"),
    feedback: $("feedback"), drill: document.querySelector(".drill"), note: $("note"), hint: $("btn-hint"), showMe: $("btn-show"),
    actions: $("actions"), next: $("btn-next"),
    material: $("material"),
    side: $("device-side"), boxes: $("boxes"),
    done: $("st-done"), acc: $("st-acc"), streak: $("st-streak"),
  }, { load: async () => null, save: async () => {}, within: cfg.drills.accept_within, gain: cfg.drills.accept_min_gain,
    cue: (kind) => sound.play(kind) });

  // Site switch: the username label follows it; the button says Continue when this player has progress here.
  const paintCta = async () => {
    const u = $("username").value.trim();
    const p = u ? await store.get(`progress|${playerKey(siteNow(), u)}`) : null;
    const done = p?.stats?.done || 0;
    $("scan-label").textContent = done ? "Continue" : "Scan games";
    $("resume").classList.toggle("empty", !done);   // keeps its line either way, so nothing below moves
    $("reset-confirm").hidden = true;
    $("btn-reset").hidden = !done;
    $("resume-text").textContent = done ? `${done} answered · ${Math.round((100 * p.stats.ok) / done)}% correct ·` : "";
  };
  // Reset: asks once inline, then clears this player's answers and review boxes (cached games and scans stay).
  $("btn-reset").addEventListener("click", () => {
    $("btn-reset").hidden = true;
    $("reset-confirm").hidden = false;
    $("btn-reset-no").focus();
  });
  $("btn-reset-no").addEventListener("click", paintCta);
  $("btn-reset-yes").addEventListener("click", async () => {
    const key = `progress|${playerKey(siteNow(), $("username").value.trim())}`;
    await store.set(key, null);
    if (trainer.key === key) trainer.resetProgress();
    await paintCta();
    $("import-note").textContent = "Progress cleared.";
  });
  const paintSite = () => {
    const site = siteNow();
    $("username-label").textContent = `${SITE_NAME[site]} username`;
    // Lichess has no "daily"; its correspondence games play that part, and classical counts with rapid.
    document.querySelector('input[name=tc][value=daily] + span').lastChild.textContent = site === "lichess" ? "Corresp." : "Daily";
    document.querySelector('input[name=tc][value=rapid]').closest("label").title = site === "lichess" ? "Rapid and classical" : "";
    paintCta();
  };
  $("site").addEventListener("change", paintSite);
  $("username").addEventListener("input", paintCta);

  const last = await store.get("last");
  if (last) {
    $("site").value = last.site === "lichess" ? "lichess" : "chesscom";
    siteSel.sync();
    $("username").value = last.username;
    // Older saves stored months; map them to the nearest time span.
    const saved = last.range || { 1: "d30", 2: "d90", 3: "d90", 6: "d182" }[last.months] || "g50";
    if ([...$("range").options].some((o) => o.value === saved)) { $("range").value = saved; range.sync(); }
    for (const box of document.querySelectorAll("input[name=tc]")) box.checked = last.timeClasses.includes(box.value);
  }
  paintSite();
  $("btn-change").addEventListener("click", () => { $("start").classList.add("open"); $("username").focus(); });
  $("start").addEventListener("submit", (e) => {
    e.preventDefault();
    const username = $("username").value.trim();
    if (!username) return;
    const timeClasses = [...document.querySelectorAll("input[name=tc]:checked")].map((b) => b.value);
    start(store, trainer, siteNow(), username, $("range").value, timeClasses);
  });

  $("btn-export").addEventListener("click", async () => {
    const username = $("username").value.trim().toLowerCase(), site = siteNow();
    const data = { username, site, progress: await store.get(`progress|${playerKey(site, username)}`) };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
    a.download = `cracktics-progress-${site === "lichess" ? "lichess-" : ""}${username}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("file-import").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const site = data.site === "lichess" ? "lichess" : "chesscom";
      await store.set(`progress|${playerKey(site, data.username)}`, data.progress);
      $("site").value = site;
      siteSel.sync();
      $("username").value = data.username;
      paintSite();
      $("import-note").textContent = `Progress for ${data.username} imported. Press Continue.`;
    } catch {
      $("import-note").textContent = "That file isn't a progress export.";
    }
  });
}

main();
