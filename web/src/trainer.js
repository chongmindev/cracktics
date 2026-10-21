// The drill: the position before one of my mistakes, me to move. Find a move as good as the engine's.
//   A move in the item's accepted list is right at once. Any other move is checked by the engine: it counts when it
//   is within drills.accept_within of the best and beats the move I played by drills.accept_min_gain. The move I
//   played in the game says so. A wrong try keeps the board live; "Hint" marks the piece to move; "Show me" gives up.
//   Only the first try is graded (a hint counts as a miss).
// Then: the best move's idea, played on the board with a caption per move, and what my game move allowed.
//
// The positions seen form a line (frames): before my move (the puzzle), my answer, the engine's line after the best
// move, and my game move with their punishing reply and its line (both branches from "before"). Moving between
// neighbouring frames slides the piece; captures fade.

import { Chess } from "chess.js";
import { liftPieces } from "./drag.js";
import { EvalBar } from "./evalbar.js";
import { material, numbered, punishment, walkthrough } from "./explain.js";

export { material };

const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const FILES = "abcdefgh";
const RESULT = { win: "Won", loss: "Lost", draw: "Drawn" };
const EVAL_SPAN = 6;   // the eval bar runs from -6 to +6 pawns; beyond that (or mate) pins to the end
const SLIDE_MS = 260;     // one move's slide
const INTRO_WAIT_MS = 500;   // a new puzzle shows the position before their move this long...
const INTRO_SLIDE_MS = 450;  // ...then plays their move, slower than a step
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
/** An eval for me: "#3" (I mate in 3), "−#2" (I get mated), else "+1.2". mate: moves, my view; v: pawns, my view. */
const fmtEval = (v, mate = null) => (mate ? (mate > 0 ? `#${mate}` : `−#${-mate}`) : fmt(v));
/** The review boxes as columns (box 0 = not answered yet): short name, and what's in it, for the hover tip. */
const BOXES = [["New", "not answered yet"], ["Missed", "missed last time"], ["1×", "right once"], ["2×", "right twice in a row"],
  ["3×", "right 3 times in a row"], ["4×+", "right 4+ times in a row"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-10-17" -> "Oct 17, 2026" (or the text as it is, if it isn't a date). */
const dateText = (d) => { const [y, m, day] = String(d || "").split(/[-.]/); return MONTHS[m - 1] && +day ? `${MONTHS[m - 1]} ${+day}, ${y}` : d || ""; };
const num = (n, white, san) => `${n}${white ? "." : "…"}${san}`;

/** Position of a pawn value on the eval bar, in percent from the left (my side winning = right). */
export function evalX(pawns, mate = false) {
  const v = mate ? Math.sign(pawns) * EVAL_SPAN : Math.max(-EVAL_SPAN, Math.min(EVAL_SPAN, pawns));
  return 50 + (50 * v) / EVAL_SPAN;
}

/**
 * The next position to show. Positions you haven't answered come first, in random order, so nothing repeats while
 * there's something new. Once every position has been answered, reviews: the ones due (a miss after 3 answers,
 * a hit after 6, 12, 24…), lowest box first, then the one you saw longest ago. Never the position just shown,
 * unless it is the only one.
 */
export function pickNext(items, { boxes, seen, turn }, curId = null, rand = Math.random) {
  const pool = items.length > 1 ? items.filter((it) => it.id !== curId) : items;
  const fresh = pool.filter((it) => !(it.id in seen));
  if (fresh.length) return fresh[Math.floor(rand() * fresh.length)];
  const ago = (it) => turn - seen[it.id];
  const due = pool.filter((it) => ago(it) >= 2 ** ((boxes[it.id] || 1) - 1) * 3);
  const order = (a, b) => (boxes[a.id] || 0) - (boxes[b.id] || 0) || ago(b) - ago(a);
  return (due.length ? due : pool).sort(order)[0];
}

export class Trainer {
  /**
   * els: {board, arrows, pop, meta, step, question, context, actions, hint, showMe, material, note, feedback, next, side,
   *       boxes, done, acc, streak, drill}
   * evaluate(fen) -> Promise<{cp, mate}> from White's view: judges a move that isn't in the accepted list.
   * analyse(fen) -> Promise<[{cp, mate, pv}]> from White's view, with the whole line: explains the moves.
   * within, gain: centipawns (drills.accept_within, drills.accept_min_gain). cue(kind): "right" / "wrong", for a sound.
   */
  constructor(els, { load, save, evaluate = null, analyse = null, within = 50, gain = 75, evalCap = 2000, cue = () => {} }) {
    Object.assign(this, { els, load, save, evaluate, analyse, within, gain, evalCap, cue });
    // The eval of the position on the board, beside it; fen -> {cp, mate} from White's view, from the deck or the engine.
    this.bar = els.board.parentElement ? new EvalBar(els.board.parentElement, els.evalLabel || null) : null;
    this.evals = new Map();
    this.asked = new Set();
    // Keyboard: ← → step through the walkthrough the board is showing (Home / End: its first and last move);
    // N goes to the next position once there is one. Ignored while typing in a field or with a modifier held.
    document.addEventListener("keydown", (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey || e.target.closest?.("input, select, textarea, [contenteditable]")) return;
      if (!this.cur || !this.els.drill?.offsetParent) return;
      const s = this.stepping, k = e.key;
      if (s && (k === "ArrowRight" || k === "ArrowLeft")) s.step(k === "ArrowRight" ? 1 : -1);
      else if (s && k === "Home") s.first();
      else if (s && k === "End") s.last();
      else if ((k === "n" || k === "N") && !this.els.next.hidden) this.next();
      else return;
      e.preventDefault();
    });
    this.items = [];
    this.progress = Trainer.freshProgress();
    this.cur = null;
    this.frames = [];
    els.hint.addEventListener("click", () => this.hint());
    els.showMe.addEventListener("click", () => this.show());
    els.next.addEventListener("click", () => this.next());
    els.feedback.addEventListener("click", (e) => { if (e.target.closest(".see-played")) this.whatItAllowed(); });
    liftPieces(els.board, {
      canLift: (s) => this.interactive() && this.game.get(s)?.color === this.game.turn(),
      tap: (s) => this.tap(s),
      selected: () => this.sel ?? null,
    });
  }

  static freshProgress() { return { boxes: {}, seen: {}, turn: 0, stats: { done: 0, ok: 0, streak: 0 } }; }

  /** Forget every answer and review box (the caller has already cleared the saved copy). */
  resetProgress() {
    this.progress = Trainer.freshProgress();
    this.paintStats();
  }

  async start() {
    this.progress = (await this.load()) || Trainer.freshProgress();
  }

  setItems(items) {
    this.items = items;
    if (!this.cur && items.length) this.next();
    this.paintStats();
  }

  meW() { return this.cur.color === "w"; }
  me() { return this.meW() ? "White" : "Black"; }
  live() { return this.step === "solve"; }

  pick() { return pickNext(this.items, this.progress, this.cur?.id); }

  sqName(r, c) { return this.meW() ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
  xy(sq) { const f = FILES.indexOf(sq[0]), r = +sq[1]; return this.meW() ? [f + 0.5, 8 - r + 0.5] : [7 - f + 0.5, r - 1 + 0.5]; }

  /** Can the player move on the board right now? Only on the puzzle position, while solving. */
  interactive() { return this.live() && !this.busy && this.view === this.beforeIdx; }

  render(anim = null) {
    const el = this.els.board;
    el.replaceChildren();
    const frame = this.frames[this.view], lm = frame?.move;
    const moves = this.interactive() ? this.game.moves({ verbose: true }) : [];
    const targets = this.sel ? moves.filter((m) => m.from === this.sel) : [];
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const s = this.sqName(r, c), p = this.game.get(s);
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.sq = s;
      b.className = "sq" + ((FILES.indexOf(s[0]) + +s[1]) % 2 === 1 ? " d" : "") + (this.sel === s ? " sel" : "");
      b.setAttribute("aria-label", s + (p ? ` ${p.color === "w" ? "white" : "black"} ${NAME[p.type]}` : ""));
      const add = (cls, text) => { const x = document.createElement("span"); x.className = cls; if (text) x.textContent = text; b.appendChild(x); };
      if (lm && (s === lm.from || s === lm.to)) add("lm");
      if (this.hintSq === s && this.interactive()) add("hintmark");
      if (c === 0) add("coord r", s[1]);
      if (r === 7) add("coord f", s[0]);
      if (p) add(`pc ${p.color}${p.type.toUpperCase()}`);
      if (targets.some((m) => m.to === s)) add("target");
      if (this.badge && this.badge.frame === this.view && this.badge.sq === s) {
        const v = document.createElement("span");
        v.className = `verdict ${this.badge.ok ? "ok" : "no"}`;
        v.innerHTML = `<svg class="icon"><use href="#i-${this.badge.ok ? "check" : "x"}"/></svg>`;
        b.appendChild(v);
      }
      b.addEventListener("click", () => this.tap(s));
      el.appendChild(b);
    }
    this.els.arrows.innerHTML = this.arrowFrame === this.view
      ? this.arrowList.map(([f, t, dashed]) => this.arrow(f, t, dashed)).join("") : "";
    this.paintMaterial();
    this.paintEval();
    if (anim) this.animate(anim);
  }

  /** The bar and "Eval: you +1.2" for the frame on the board; the engine fills in positions the deck has no eval for. */
  paintEval() {
    const fr = this.frames[this.view];
    if (!this.bar || !fr) return;
    const known = this.evals.get(fr.fen);
    if (known) return this.bar.set(known.cp, known.mate, this.meW());
    this.bar.clear(true);
    if (!this.evaluate || this.asked.has(fr.fen)) return;
    const fen = fr.fen;
    this.asked.add(fen);
    this.evaluate(fen).then((l) => {
      if (!l) return;
      this.evals.set(fen, { cp: l.cp, mate: l.mate || null });
      if (this.frames[this.view]?.fen === fen) this.bar.set(l.cp, l.mate || null, this.meW());
    }).catch(() => {}).finally(() => this.asked.delete(fen));
  }

  // ---------- the line: frames, stepping, animation ----------

  /** Add a position reached by `move` (a chess.js verbose move) from frame `parent`. Returns its index. */
  addFrame(fen, move, parent, who, san) {
    this.frames.push({ fen, move, parent, who, san });
    return this.frames.length - 1;
  }

  /** Show frame i. Moving to a child frame plays its move; moving back to the parent plays it in reverse. */
  goto(i, { quiet = false, ms = SLIDE_MS } = {}) {
    clearTimeout(this.introTimer);
    if (i == null || i < 0 || i >= this.frames.length || (i === this.view && !quiet)) return;
    const from = this.view, fr = this.frames[i], old = this.frames[from];
    let anim = null;
    if (fr.parent === from && fr.move?.from) anim = { move: fr.move, reverse: false, ms };
    else if (old?.parent === i && old.move?.from) anim = { move: old.move, reverse: true, ms };
    this.view = i;
    this.game = new Chess(fr.fen);
    this.sel = null;
    this.render(anim);
  }

  paintMaterial() {
    const fr = this.frames[this.view];
    if (!fr) return;
    const mat = material(fr.fen) * (this.meW() ? 1 : -1);
    this.els.material.textContent = mat ? `Material: you ${mat > 0 ? "+" : "−"}${Math.abs(mat)}` : "Material: even";
  }

  animate({ move, reverse, ms = SLIDE_MS }) {
    if (reducedMotion()) return;
    const board = this.els.board, size = board.clientWidth / 8;
    const square = (s) => board.querySelector(`[data-sq="${s}"]`);
    const slide = (a, b) => {   // the piece now standing on b arrives from a
      const sq = square(b), pc = sq?.querySelector(".pc");
      if (!pc?.animate) return;
      const [x1, y1] = this.xy(a), [x2, y2] = this.xy(b);
      sq.style.zIndex = 3;
      const an = pc.animate([{ transform: `translate(${(x1 - x2) * size}px, ${(y1 - y2) * size}px)` }, { transform: "none" }],
        { duration: ms, easing: "cubic-bezier(.2,.7,.3,1)" });
      an.onfinish = () => { sq.style.zIndex = ""; };
    };
    const [a, b] = reverse ? [move.to, move.from] : [move.from, move.to];
    slide(a, b);
    if (/[kq]/.test(move.flags)) {    // castling: the rook moves too
      const r = move.from[1], [rf, rt] = move.flags.includes("k") ? ["h" + r, "f" + r] : ["a" + r, "d" + r];
      reverse ? slide(rt, rf) : slide(rf, rt);
    }
    if (!move.captured) return;
    const capSq = move.flags.includes("e") ? move.to[0] + move.from[1] : move.to;
    const capClass = `pc ${move.color === "w" ? "b" : "w"}${move.captured.toUpperCase()}`;
    const sq = square(capSq);
    if (!sq) return;
    if (reverse) {      // the captured piece comes back
      const pc = [...sq.querySelectorAll(".pc")].find((p) => p.className === capClass);
      pc?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay: ms / 2, fill: "backwards" });
    } else {            // the captured piece fades under the arriving one
      const ghost = document.createElement("span");
      ghost.className = capClass + " ghost";
      sq.insertBefore(ghost, sq.querySelector(".pc"));
      const an = ghost.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 1.4, easing: "ease-in" });
      if (an) an.onfinish = () => ghost.remove(); else ghost.remove();
    }
  }

  /** A big check over the board, fading out. */
  pop() {
    const el = this.els.pop;
    if (!el) return;
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
    clearTimeout(this.popTimer);
    this.popTimer = setTimeout(() => el.classList.remove("show"), 1000);
  }

  shake() {
    if (reducedMotion()) return;
    this.els.board.parentElement.animate?.(
      [0, -7, 7, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })), { duration: 300, easing: "ease-out" });
  }

  setArrows(list, frame) {
    this.arrowList = list;
    this.arrowFrame = frame;
  }

  /** Solid arrow = the right move, dashed = a try that didn't work. */
  arrow(from, to, dashed = false) {
    const [x1, y1] = this.xy(from), [x2, y2] = this.xy(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const ex = x2 - ux * 0.32, ey = y2 - uy * 0.32, hx = x2 - ux * 0.12, hy = y2 - uy * 0.12;
    const px = -uy * 0.22, py = ux * 0.22, bx = x2 - ux * 0.45, by = y2 - uy * 0.45;
    return `<line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width=".14"${dashed ? ' stroke-dasharray=".22 .14"' : ""}/>` +
      `<polygon points="${hx},${hy} ${bx + px},${by + py} ${bx - px},${by - py}"/>`;
  }

  tap(s) {
    if (!this.live() || this.busy) return;
    if (this.view !== this.beforeIdx) return this.goto(this.beforeIdx);
    const p = this.game.get(s);
    if (this.sel) {
      const m = this.game.moves({ verbose: true }).find((m) => m.from === this.sel && m.to === s);
      if (m) { this.sel = null; return this.answer(m); }
    }
    this.sel = p && p.color === this.game.turn() && this.sel !== s ? s : null;
    this.render();
  }

  // ---------- solving ----------

  async answer(m) {
    const cur = this.cur, uci = m.from + m.to;
    this.setArrows([[m.from, m.to, false]], this.beforeIdx);
    if (cur.accept.some((u) => u.slice(0, 4) === uci)) return this.solved(m, null);
    if (uci === cur.from + cur.to) return this.miss(m, `That's what you played in the game: it cost ${cur.swing.toFixed(1)}. Try again.`);
    if (!this.evaluate) return this.miss(m, `<b>${esc(m.san)}</b> isn't it. Try again.`);
    this.busy = true;
    this.render();
    this.note(`Checking <b>${esc(m.san)}</b>…`);
    let line;
    try { line = await this.evaluate(this.after(cur.before_fen, m)); } catch { line = null; }
    this.busy = false;
    if (this.cur !== cur || this.step !== "solve") return;
    if (!line) return this.miss(m, "Couldn't check that move. Try another.", false);
    const mine = (this.meW() ? line.cp : -line.cp) / 100;
    if (mine * 100 >= cur.evb * 100 - this.within && mine * 100 >= cur.eva * 100 + this.gain) return this.solved(m, mine);
    this.miss(m, `<b>${esc(m.san)}</b> isn't enough (${fmt(mine)}; the best move keeps ${fmt(cur.evb)}). Try again.`);
  }

  miss(m, msg, graded = true) {
    if (graded && this.firstTry === null) this.grade(false);
    this.cue("wrong");
    this.shake();
    this.setArrows([[m.from, m.to, true]], this.beforeIdx);
    this.badge = { sq: m.to, ok: false, frame: this.beforeIdx };
    this.note(msg);
    this.els.showMe.hidden = false;
    this.render();
  }

  /** Mark the piece the best move moves. Counts as a miss. */
  hint() {
    if (!this.live()) return;
    let m = null;
    try { m = new Chess(this.cur.before_fen).move(this.cur.better); } catch {}
    if (!m) return;
    if (this.firstTry === null) this.grade(false);
    this.hintSq = m.from;
    this.els.hint.hidden = true;
    this.els.showMe.hidden = false;
    this.note(`Move the ${NAME[m.piece]} on ${m.from}.`);
    this.render();
  }

  show() {
    if (!this.live()) return;
    if (this.firstTry === null) this.grade(false);
    let m = null;
    try { m = new Chess(this.cur.before_fen).move(this.cur.better); } catch {}
    this.solved(m, null, true);
  }

  /** The puzzle is over: the answer on the board, what the game move cost, then the idea behind the best move. */
  solved(m, evalAfter, shown = false) {
    const cur = this.cur, white = this.meW();
    if (this.firstTry === null) this.grade(true);
    this.setArrows([], null);
    this.step = "done";
    this.hintSq = null;
    if (!shown) { this.cue("right"); this.pop(); }
    if (m) {
      const i = this.addFrame(this.after(cur.before_fen, m), m, this.beforeIdx, "me", num(cur.move, white, m.san));
      this.badge = shown ? null : { sq: m.to, ok: true, frame: i };
      this.goto(i);
    }
    const best = m && m.san === cur.better;
    const others = cur.accept_san.filter((x) => x !== cur.better && x !== m?.san);
    const head = shown ? "Here it is" : this.firstTry ? (best ? "Best move" : "Good move") : "Got there";
    // Every card shows its eval for you: the best move's is the position's eval before the mistake.
    const bestEv = fmtEval(cur.evb, cur.mate);
    const pending = !shown && !best && evalAfter == null && this.evaluate;   // another accepted move: ask the engine
    const yours = shown ? "" : this.card(best ? "Your move · engine's choice" : "Your move holds", num(cur.move, white, m.san), "key",
      evalAfter != null ? fmt(evalAfter) : best ? bestEv : pending ? "…" : "as good as the best");
    const cards = yours +
      (best && !shown ? "" : this.card("Best move", num(cur.move, white, cur.better), shown ? "key" : "", bestEv)) +
      this.card("In the game you played", num(cur.move, white, cur.san), "struck", `${fmt(cur.eva)} · cost ${cur.swing.toFixed(1)}`);
    const also = others.length ? `<p class="also label">Also good: ${others.map(esc).join(", ")}</p>` : "";
    const see = cur.reply ? `<button type="button" class="link-btn see-played">What ${esc(cur.san)} allowed: ${esc(cur.reply)}</button>` : "";
    const bar = cur.mate ? `<div class="mate">Mate in ${cur.mate} for you</div>` : this.evalBar(cur.evb, cur.eva);
    this.feedback(!shown && this.firstTry === true, head, cards, bar + also + see);
    if (pending) {
      this.evaluate(this.after(cur.before_fen, m)).then((l) => {
        const sub = this.cur === cur && this.els.feedback.querySelector(".card.key .sub");
        if (!sub || !l) return;
        const sign = white ? 1 : -1;
        sub.textContent = fmtEval((sign * l.cp) / 100, l.mate ? sign * l.mate : null);
      }).catch(() => {});
    }
    this.finish();
    this.walk(cur);
  }

  /**
   * Fill a walkthrough box: every caption at once, the board following the row you're on. You step through by
   * clicking a row or the button; nothing plays by itself. Returns show(k), which moves the board to step k.
   */
  stepper(box, head, w, idx, token) {
    const rows = w.steps.map((st, k) =>
      `<li><button type="button" data-k="${k}"><b>${esc(numbered(st.ply.before, st.ply.move))}</b><span>${st.text}</span></button></li>`).join("");
    box.innerHTML = head + `<ol class="walk-steps">${rows}</ol>` + (w.idea ? `<p class="walk-sum">${esc(w.summary)}</p>` : "") +
      (idx.length > 1 ? `<button class="btn ghost walk-step" type="button" title="Or use the arrow keys: ← →"></button>` : "");
    const step = box.querySelector(".walk-step");
    let at = 0;
    const show = (k) => {
      if (this.walkToken !== token) return;
      at = Math.max(0, Math.min(idx.length - 1, k));
      this.goto(idx[at]);
      // One row lit across both walkthroughs: the one the board shows. The arrow keys step this one.
      this.els.feedback.querySelectorAll(".walk-steps li.on").forEach((li) => li.classList.remove("on"));
      box.querySelectorAll(".walk-steps li").forEach((li, j) => li.classList.toggle("on", j === at));
      this.stepping = { step: (d) => show(at + d), first: () => show(0), last: () => show(idx.length - 1) };
      k = at;
      if (step) step.innerHTML = k < idx.length - 1 ? `Next move <svg class="icon"><use href="#i-next"/></svg>`
        : `<svg class="icon"><use href="#i-replay"/></svg>From the start`;
    };
    box.querySelector(".walk-steps").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) show(+b.dataset.k); });
    step?.addEventListener("click", () => show(at < idx.length - 1 ? at + 1 : 0));
    return show;
  }

  /** What my game move allowed: it and their punishing reply, then the engine's line, stepped like the idea. */
  async whatItAllowed() {
    const cur = this.cur, fb = this.els.feedback.querySelector(".fb");
    if (!fb || !cur.reply) return;
    fb.querySelector(".see-played")?.remove();
    const token = this.walkToken;   // this puzzle's: both walkthroughs stay live until the next one
    let mine = null, rm = null;
    try { mine = new Chess(cur.before_fen).move(cur.san); rm = new Chess(cur.fen).move(cur.reply); } catch {}
    if (!mine || !rm) return;
    const playedIdx = this.addFrame(cur.fen, mine, this.beforeIdx, "game", num(cur.move, this.meW(), cur.san));
    const replyIdx = this.addFrame(this.after(cur.fen, rm), rm, playedIdx, "them", numbered(cur.fen, rm));
    const head = `<p class="label">What ${esc(cur.san)} allowed · ${esc(this.frames[replyIdx].san)}</p>`;
    const box = document.createElement("div");
    box.className = "walk why";
    box.innerHTML = head + `<p class="walk-wait">Working it out…</p>`;
    fb.appendChild(box);
    let line = null;
    try { if (this.analyse) [line] = await this.analyse(this.frames[replyIdx].fen); } catch {}
    if (this.walkToken !== token) return;
    let w;
    try { w = punishment({ after: cur.fen, reply: cur.reply, before: cur.before_fen, played: cur.san, line, mate: null }); }
    catch { box.remove(); return; }
    let at = replyIdx;
    const idx = w.steps.map(({ ply }, k) => (k === 0 ? replyIdx : (at = this.addFrame(ply.after, ply.move, at, "pv", numbered(ply.before, ply.move)))));
    const show = this.stepper(box, head, w, idx, token);
    this.goto(this.beforeIdx);
    this.goto(playedIdx);
    await sleep(SLIDE_MS + 200);
    if (this.walkToken !== token) return;
    show(0);
    this.showInDrill(box);
  }

  /** The idea behind the engine's move: its line played on the board, a caption per move (or one line if quiet). */
  async walk(cur) {
    const fb = this.els.feedback.querySelector(".fb");
    if (!fb || !cur.better || !cur.before_fen) return;
    const token = this.walkToken;   // this puzzle's: both walkthroughs stay live until the next one
    const head = `<p class="label">The idea · ${esc(num(cur.move, this.meW(), cur.better))}</p>`;
    const box = document.createElement("div");
    box.className = "walk";
    box.innerHTML = head + `<p class="walk-wait">Working it out…</p>`;
    fb.insertBefore(box, fb.querySelector(".see-played"));
    let line = null;
    try {
      const bm = new Chess(cur.before_fen).move(cur.better);
      if (this.analyse) [line] = await this.analyse(bm.after);
    } catch {}
    if (this.walkToken !== token) return;
    let w;
    try { w = walkthrough({ before: cur.before_fen, played: cur.san, reply: cur.reply, better: cur.better, line }); }
    catch { box.remove(); return; }
    // The engine's move (a branch from "before", unless it was the answer just played) and its line become frames.
    let at = this.frames.findIndex((f) => f.parent === this.beforeIdx && f.move?.san === cur.better);
    const idx = w.steps.map(({ ply }, k) => {
      if (k === 0) return at >= 0 ? at : (at = this.addFrame(ply.after, ply.move, this.beforeIdx, "me", numbered(ply.before, ply.move)));
      return (at = this.addFrame(ply.after, ply.move, at, "pv", numbered(ply.before, ply.move)));
    });
    const show = this.stepper(box, head, w, idx, token);
    if (this.stepping) return;   // "What X allowed" was opened while this was worked out: leave the board to it
    if (this.view !== idx[0]) {
      this.goto(this.beforeIdx);
      await sleep(500);
      if (this.walkToken !== token || this.stepping) return;
    }
    show(0);
    this.showInDrill(this.els.next);
  }

  /** FEN after playing a verbose move from `fen`. */
  after(fen, m) {
    const g = new Chess(fen);
    g.move({ from: m.from, to: m.to, promotion: m.promotion });
    return g.fen();
  }

  // ---------- shared ----------

  finish() {
    this.step = "done";
    this.els.actions.hidden = true;
    this.els.next.hidden = false;
    this.els.next.focus({ preventScroll: true });
    this.showInDrill(this.els.next);
    this.paintStep();
    this.render();
  }

  /** On desktop the panel scrolls by itself: bring `el` into it. On phones the page scrolls, and is left alone
   *  so the board stays in view. */
  showInDrill(el) {
    const d = this.els.drill;
    if (!d || d.scrollHeight <= d.clientHeight) return;
    const r = el.getBoundingClientRect(), dr = d.getBoundingClientRect();
    if (r.bottom > dr.bottom) d.scrollTop += r.bottom - dr.bottom + 8;
    else if (r.top < dr.top) d.scrollTop -= dr.top - r.top + 8;
  }

  paintStep() {
    this.els.step.textContent = this.step === "solve" ? `Move ${this.cur.move} · ${this.me()} to play` : "Done · Next position when ready";
    this.els.step.dataset.step = this.step;
  }

  grade(ok) {
    this.firstTry = ok;
    const pr = this.progress, cur = this.cur, b = pr.boxes[cur.id] || 0;
    pr.boxes[cur.id] = ok ? Math.min(5, Math.max(1, b) + 1) : 1;
    pr.seen[cur.id] = pr.turn++;
    pr.stats.done++;
    if (ok) { pr.stats.ok++; pr.stats.streak++; } else pr.stats.streak = 0;
    this.save(pr);
    this.paintStats();
  }

  note(html) {
    this.els.note.innerHTML = html;
    this.els.note.hidden = !html;
  }

  feedback(ok, head, cards, bar) {
    const link = this.cur.link ? `<a class="game-link" href="${esc(this.cur.link)}" target="_blank" rel="noopener">Game <span class="arr" aria-hidden="true">↗</span></a>` : "";
    this.note("");
    this.els.feedback.innerHTML = `<div class="fb ${ok ? "ok" : "no"}" role="status">
      <div class="fb-head"><h2>${head}</h2>${link}</div><div class="cards">${cards}</div>${bar}</div>`;
  }

  evalBar(before, after) {
    const a = evalX(before), b = evalX(after);
    const lo = Math.min(a, b), hi = Math.max(a, b);
    return `<div class="evalbar" role="img" aria-label="Evaluation for you: ${fmt(before)} before your move, ${fmt(after)} after">
      <div class="track"><i class="zero"></i><i class="span" style="left:${lo}%;width:${hi - lo}%"></i>
        <i class="pt before" style="left:${a}%"></i><i class="pt after" style="left:${b}%"></i></div>
      <div class="ends"><span>${fmt(before)}</span><span class="arrow">→</span><span>${fmt(after)}</span></div>
    </div>`;
  }

  card(label, move, cls = "", sub = "") {
    return `<div class="card ${cls}"><span class="label">${label}</span><b>${esc(move)}</b>${sub ? `<span class="sub">${esc(sub)}</span>` : ""}</div>`;
  }

  paintStats() {
    const { stats, boxes } = this.progress;
    this.els.done.textContent = stats.done;
    this.els.acc.textContent = stats.done ? Math.round((100 * stats.ok) / stats.done) + "%" : "–";
    this.els.streak.textContent = stats.streak;
    const counts = [0, 0, 0, 0, 0, 0];
    for (const it of this.items) counts[boxes[it.id] || 0]++;
    const max = Math.max(...counts, 1);
    this.els.boxes.innerHTML = counts.map((n, i) => `<div tabindex="0" data-tip="${n} position${n === 1 ? "" : "s"} ${BOXES[i][1]}" aria-label="${BOXES[i][0]}: ${n} position${n === 1 ? "" : "s"} ${BOXES[i][1]}"><b>${n}</b><i style="height:${Math.round(2 + (18 * n) / max)}px"></i><span>${BOXES[i][0]}</span></div>`).join("");
  }

  next() {
    this.cur = this.pick();
    if (!this.cur) return;
    const cur = this.cur;
    this.game = new Chess(cur.before_fen);
    this.sel = null;
    this.step = "solve";
    this.firstTry = null;
    this.busy = false;
    this.walkToken = {};
    this.stepping = null;
    this.badge = null;
    this.hintSq = null;
    this.setArrows([], null);
    this.frames = [];
    // The deck's evals (pawns, my view) for the puzzle and my game move, as White's view in centipawns.
    // A clamped eval (at engine.eval_cap, give or take rounding; often a mate the deck doesn't record) is left for the engine.
    const sign = cur.color === "w" ? 1 : -1, capped = (v) => Math.abs(v) * 100 >= this.evalCap - 10;
    if (cur.mate || !capped(cur.evb)) this.evals.set(cur.before_fen, { cp: sign * Math.round(cur.evb * 100), mate: cur.mate ? sign * cur.mate : null });
    if (!capped(cur.eva)) this.evals.set(cur.fen, { cp: sign * Math.round(cur.eva * 100), mate: null });
    // The puzzle opens on the position before their move and plays it, so you see what they just did. Older
    // decks (no prev) and a first move start on the puzzle itself.
    let prevMove = null;
    try { if (cur.prev_fen && cur.prev) prevMove = new Chess(cur.prev_fen).move(cur.prev); } catch {}
    const prevIdx = prevMove ? this.addFrame(cur.prev_fen, null, null, null, "") : null;
    this.beforeIdx = this.addFrame(cur.before_fen, prevMove, prevIdx, prevMove ? "them" : null,
      prevMove ? num(prevMove.color === "w" ? cur.move : cur.move - 1, prevMove.color === "w", prevMove.san) : "");
    this.view = prevIdx ?? this.beforeIdx;
    if (prevIdx != null) this.game = new Chess(cur.prev_fen);
    this.els.meta.innerHTML = `<span>vs ${esc(cur.opp)}</span><span>${esc(dateText(cur.date))}</span><span>${RESULT[cur.result] || ""}</span>`;
    this.els.question.textContent = `Find the best move for ${this.me()}.`;
    const theirs = prevMove ? `They just played ${this.frames[this.beforeIdx].san}. ` : "";
    this.els.context.textContent = `${theirs}You went wrong here in this game. ${cur.mate ? `There's a mate in ${cur.mate}.` : ""}`.trim();
    if (this.els.side) this.els.side.textContent = `You play ${this.me()}`;
    this.els.board.setAttribute("aria-label", `Chess board, ${this.me()} at the bottom`);
    this.els.feedback.innerHTML = "";
    this.note("");
    this.els.actions.hidden = false;
    this.els.hint.hidden = false;
    this.els.showMe.hidden = true;
    this.els.next.hidden = true;
    this.paintStep();
    this.paintStats();
    this.render();
    clearTimeout(this.introTimer);
    if (prevIdx != null) {
      const go = () => this.goto(this.beforeIdx, { ms: INTRO_SLIDE_MS });
      if (reducedMotion()) go(); else this.introTimer = setTimeout(go, INTRO_WAIT_MS);
    }
  }
}
