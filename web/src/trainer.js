// The drill, in up to two steps:
//   find: the position right after my move. Play the opponent's punishing reply, or say nothing works.
//         A wrong try says so and the board stays live; "Reveal" gives up. Only the first try is graded.
//         Their reply is then played on the board, and the player moves on when ready ("Fix your move").
//   fix:  for a real blunder, the board rewinds to before my move: play what I should have played.
//         The engine judges it (within trainer.fix_tolerance of the best eval counts); "Show me" gives up.
//
// The positions seen so far form a line (frames): before my move, after it, after their reply, my fix (a branch
// from "before") and the engine's line after it. Moving between neighbouring frames slides the piece; captures
// fade. A new position plays my move from "before"; the fix step rewinds their reply and my move; at the end
// the engine's line is walked through on the board with a caption per move.

import { Chess } from "chess.js";
import { material, numbered, punishment, walkthrough } from "./explain.js";

export { material };

const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const FILES = "abcdefgh";
const RESULT = { win: "Won", loss: "Lost", draw: "Drawn" };
const EVAL_SPAN = 6;   // the eval bar runs from -6 to +6 pawns; beyond that (or mate) pins to the end
const SLIDE_MS = 260;     // one move's slide
const REWIND_MS = 320;    // a move played backwards, a little slower than forwards
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INTRO_MS = 450;     // a new position shows "before" this long, then my move plays
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (v) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(1);
const num = (n, white, san) => `${n}${white ? "." : "…"}${san}`;

/**
 * What a defensive scan looks at, for the side to move in `fen` (the opponent):
 * their checks and captures, and my pieces they attack that nothing of mine defends.
 */
export function scanSets(fen) {
  const g = new Chess(fen);
  const moves = g.moves({ verbose: true });
  const opp = g.turn(), me = opp === "w" ? "b" : "w";
  const loose = [];
  for (const row of g.board()) for (const sq of row) {
    if (!sq || sq.color !== me || sq.type === "k") continue;
    if (g.attackers(sq.square, opp).length && !g.attackers(sq.square, me).length) loose.push(sq.square);
  }
  return {
    checks: moves.filter((m) => /[+#]/.test(m.san)),
    captures: moves.filter((m) => /[ce]/.test(m.flags)),
    loose,
  };
}

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
   * els: {board, arrows, pop, meta, step, playedLabel, played, question, scan, actions, safe, reveal, fixRow, showMe,
   *       material, feedback, next, fixGo, side, boxes, done, acc, streak}
   * evaluate(fen) -> Promise<{cp, mate}> from White's view; used by the fix step. tolerance in centipawns.
   * cue(kind): "right" / "wrong", for a sound.
   * analyse(fen) -> Promise<[{cp, mate, pv}]> from White's view, with the whole line; used to explain the fix.
   */
  constructor(els, { load, save, evaluate = null, analyse = null, tolerance = 100, cue = () => {} }) {
    Object.assign(this, { els, load, save, evaluate, analyse, tolerance, cue });
    this.items = [];
    this.progress = Trainer.freshProgress();
    this.cur = null;
    this.frames = [];
    els.safe.addEventListener("click", () => this.say(null));
    els.reveal.addEventListener("click", () => this.reveal());
    els.showMe.addEventListener("click", () => this.showFix());
    els.next.addEventListener("click", () => this.next());
    els.fixGo.addEventListener("click", () => this.startFix());
    els.scan.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-kind]");
      if (!chip || this.step !== "find") return;
      const kind = chip.dataset.kind;
      if (this.lit.has(kind)) this.lit.delete(kind); else this.lit.add(kind);
      this.paintScan();
      this.render();
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
  opp() { return this.meW() ? "Black" : "White"; }
  live() { return this.step === "find" || this.step === "fix"; }

  pick() { return pickNext(this.items, this.progress, this.cur?.id); }

  sqName(r, c) { return this.meW() ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
  xy(sq) { const f = FILES.indexOf(sq[0]), r = +sq[1]; return this.meW() ? [f + 0.5, 8 - r + 0.5] : [7 - f + 0.5, r - 1 + 0.5]; }

  litSquares() {
    const moveSq = new Set(), loose = new Set();
    if (this.step !== "find" || this.view !== this.liveIdx) return { moveSq, loose };
    for (const kind of ["checks", "captures"]) if (this.lit.has(kind)) for (const m of this.scan[kind]) { moveSq.add(m.from); moveSq.add(m.to); }
    if (this.lit.has("loose")) for (const s of this.scan.loose) loose.add(s);
    return { moveSq, loose };
  }

  /** Can the player move on the board right now? Only on the live frame of a live step. */
  interactive() { return this.live() && !this.busy && this.view === this.liveIdx; }

  render(anim = null) {
    const el = this.els.board;
    el.replaceChildren();
    const frame = this.frames[this.view], lm = frame?.move;
    const moves = this.interactive() ? this.game.moves({ verbose: true }) : [];
    const targets = this.sel ? moves.filter((m) => m.from === this.sel) : [];
    const { moveSq, loose } = this.litSquares();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const s = this.sqName(r, c), p = this.game.get(s);
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.sq = s;
      b.className = "sq" + ((FILES.indexOf(s[0]) + +s[1]) % 2 === 1 ? " d" : "") + (this.sel === s ? " sel" : "");
      b.setAttribute("aria-label", s + (p ? ` ${p.color === "w" ? "white" : "black"} ${NAME[p.type]}` : ""));
      const add = (cls, text) => { const x = document.createElement("span"); x.className = cls; if (text) x.textContent = text; b.appendChild(x); };
      if (lm && (s === lm.from || s === lm.to)) add("lm");
      if (moveSq.has(s)) add("hintmark");
      if (loose.has(s)) add("loose");
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
    if (anim) this.animate(anim);
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
    if (this.view !== this.liveIdx) return this.goto(this.liveIdx);   // still showing "before" (intro): jump to the position
    const p = this.game.get(s);
    if (this.sel) {
      const m = this.game.moves({ verbose: true }).find((m) => m.from === this.sel && m.to === s);
      if (m) { this.sel = null; return this.step === "find" ? this.say(m) : this.tryFix(m); }
    }
    this.sel = p && p.color === this.game.turn() && this.sel !== s ? s : null;
    this.render();
  }

  // ---------- step 1: find their punishment ----------

  /** An answer in the find step: a move, or null for "nothing works". */
  say(m) {
    if (this.step !== "find") return;
    const cur = this.cur;
    const right = cur.kind === "threat"
      ? !!m && cur.accept.some((u) => u.slice(0, 4) === m.from + m.to)
      : !m;
    if (this.firstTry === null) this.grade(right);
    if (right) return this.found(m);
    // Wrong: say so, keep the board live.
    this.tries++;
    this.cue("wrong");
    this.shake();
    this.setArrows(m ? [[m.from, m.to, true]] : [], this.liveIdx);
    this.badge = m ? { sq: m.to, ok: false, frame: this.liveIdx } : null;
    const msg = cur.kind === "threat"
      ? (m ? `<b>${esc(m.san)}</b> isn't it. Try again.` : "There is a punishment. Keep looking.")
      : `<b>${esc(m.san)}</b> doesn't win anything. Look again.`;
    this.note(msg);
    this.els.reveal.hidden = false;
    this.render();
  }

  reveal() {
    if (this.step !== "find") return;
    if (this.firstTry === null) this.grade(false);
    this.found(null, true);
  }

  /** The find step is over: play their reply on the board, then wait for the player to go on to the fix step. */
  found(m, revealed = false) {
    const cur = this.cur, white = this.meW(), opp = this.opp();
    const theirs = white ? num(cur.move, false, cur.reply) : num(cur.move + 1, true, cur.reply);
    this.els.scan.hidden = true;
    this.els.actions.hidden = true;
    if (!revealed) { this.cue("right"); this.pop(); }
    let rm = null;
    try { rm = new Chess(cur.fen).move(cur.reply); } catch {}
    this.setArrows([], null);
    this.step = "found";
    this.liveIdx = null;
    let replyIdx = this.replyIdx = null;
    if (rm) {
      const i = replyIdx = this.replyIdx = this.addFrame(this.after(cur.fen, rm), rm, this.findIdx, "them", theirs);
      this.badge = !revealed && cur.kind === "threat" ? { sq: rm.to, ok: true, frame: i } : null;
      this.goto(i);
    }
    const myCap = this.frames[this.findIdx].move?.captured;
    if (cur.kind === "threat") {
      const head = revealed ? "Here it is" : this.firstTry ? "Found it" : "Got there";
      const bar = cur.mate != null && cur.mate > 0 ? `<div class="mate">Mate in ${cur.mate}</div>` : this.evalBar(cur.evb, cur.eva);
      this.feedback(this.firstTry === true, head,
        this.card(`${opp}'s punishment`, theirs, "key", this.what(rm)) +
        this.card("You played", num(cur.move, white, cur.san), "struck", myCap ? `took a ${NAME[myCap]}` : ""), bar);
      if (cur.before_fen && cur.better) {
        this.els.fixGo.hidden = false;
        this.els.fixGo.focus({ preventScroll: true });
        this.showInDrill(this.els.fixGo);
        this.paintStep();
        this.whyItWorks(cur, replyIdx);
        return;
      }
      this.finish();
      this.whyItWorks(cur, replyIdx);
    } else {
      this.feedback(this.firstTry === true, revealed ? "It was safe" : this.firstTry ? "Safe. Well judged" : "Safe after all",
        this.card(`${opp}'s best try`, theirs, "", this.what(rm)), this.evalBar(cur.evb, cur.eva));
      this.finish();
    }
  }

  /** What their move does, in a few words: checkmate, takes your knight, check. */
  what(m) {
    if (!m) return "";
    if (m.san.endsWith("#")) return "checkmate";
    if (m.captured) return `takes your ${NAME[m.captured]}${m.san.endsWith("+") ? ", check" : ""}`;
    return m.san.endsWith("+") ? "check" : "";
  }

  /** FEN after playing a verbose move from `fen`. */
  after(fen, m) {
    const g = new Chess(fen);
    g.move({ from: m.from, to: m.to, promotion: m.promotion });
    return g.fen();
  }

  // ---------- step 2: fix my move ----------

  async startFix() {
    if (this.step !== "found") return;
    const cur = this.cur;
    this.step = "fix";
    this.fixTries = 0;
    this.liveIdx = this.beforeIdx;
    this.badge = null;
    this.setArrows([], null);
    this.els.fixGo.hidden = true;
    this.els.playedLabel.textContent = "Instead of";
    this.els.question.textContent = "What should you have played?";
    this.els.fixRow.hidden = false;
    this.els.showMe.hidden = true;
    this.paintStep();
    // Play their reply and my move backwards, marked as a rewind, then hand the board over.
    this.busy = true;
    this.walkToken = null;
    this.els.feedback.querySelector(".why")?.classList.add("done");
    // From further down their line, jump back to their reply first; then rewind their reply and my move.
    await this.rewind([this.replyIdx, this.findIdx, this.beforeIdx]);
    if (this.cur !== cur || this.step !== "fix") return;
    this.busy = false;
    this.render();
  }

  async rewind(path) {
    const box = this.els.board.parentElement, motion = !reducedMotion();
    box.classList.add("rewinding");
    this.els.step.textContent = "Rewinding to before your move";
    if (motion) await sleep(120);
    for (const i of path) {
      if (i == null || i === this.view) continue;
      this.goto(i, { ms: REWIND_MS });
      if (motion) await sleep(REWIND_MS + 60);
    }
    box.classList.remove("rewinding");
    this.paintStep();
  }

  async tryFix(m) {
    const cur = this.cur;
    this.fixTries++;
    this.setArrows([[m.from, m.to, false]], this.liveIdx);
    if (m.san === cur.better) return this.fixed(m.san, null, true);
    if (m.from + m.to === cur.from + cur.to) return this.fixNote(m, "That's the move you played.");
    if (!this.evaluate) return this.fixNote(m, "Not the engine's move. Try again.");
    this.busy = true;
    this.render();
    this.note(`Checking <b>${esc(m.san)}</b>…`);
    const after = new Chess(cur.before_fen);
    after.move({ from: m.from, to: m.to, promotion: m.promotion });
    let line;
    try { line = await this.evaluate(after.fen()); } catch { line = null; }
    this.busy = false;
    if (this.cur !== cur || this.step !== "fix") return;
    if (!line) return this.fixNote(m, "Couldn't check that move. Try another.");
    const mine = (this.meW() ? line.cp : -line.cp) / 100;
    if (mine * 100 >= cur.evb * 100 - this.tolerance) return this.fixed(m.san, mine, false);
    this.fixNote(m, `<b>${esc(m.san)}</b> still costs you (${fmt(mine)}). Try again.`);
  }

  fixNote(m, msg) {
    this.cue("wrong");
    this.shake();
    this.setArrows([[m.from, m.to, true]], this.liveIdx);
    this.badge = { sq: m.to, ok: false, frame: this.liveIdx };
    this.note(msg);
    this.els.showMe.hidden = false;
    this.render();
  }

  showFix() {
    if (this.step !== "fix") return;
    this.fixed(this.cur.better, null, false, true);
  }

  /** The fix step is over: one block sums up the whole position (their punishment, my move, the fix). */
  fixed(san, evalAfter, best, shown = false) {
    const cur = this.cur, white = this.meW(), opp = this.opp();
    let m = null;
    try { m = new Chess(cur.before_fen).move(san); } catch {}
    this.setArrows([], null);
    this.step = "done";
    this.liveIdx = null;
    if (!shown) { this.cue("right"); this.pop(); }
    if (m) {
      const i = this.addFrame(this.after(cur.before_fen, m), m, this.beforeIdx, "fix", num(cur.move, white, m.san));
      this.badge = shown ? null : { sq: m.to, ok: true, frame: i };
      this.goto(i);
    }
    const theirs = white ? num(cur.move, false, cur.reply) : num(cur.move + 1, true, cur.reply);
    const cards =
      this.card(`${opp}'s punishment`, theirs) +
      this.card("You played", num(cur.move, white, cur.san), "struck") +
      (shown ? this.card("Should have played", num(cur.move, white, cur.better), "key", m?.captured ? `takes a ${NAME[m.captured]}` : "")
        : this.card(best ? "Your fix · engine's move" : "Your fix holds", num(cur.move, white, san), "key", m?.captured ? `takes a ${NAME[m.captured]}` : "") +
          (best ? "" : this.card("Engine's move", num(cur.move, white, cur.better))));
    const note = evalAfter == null ? "" : `<div class="evalbar-note label">After ${esc(san)} ${fmt(evalAfter)} · best ${fmt(cur.evb)}</div>`;
    this.feedback(!shown && this.firstTry === true, shown ? "Here's the fix" : this.firstTry ? "Found and fixed" : "Fixed", cards, note);
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
      (idx.length > 1 ? `<button class="btn ghost walk-step" type="button"></button>` : "");
    const step = box.querySelector(".walk-step");
    let at = 0;
    const show = (k) => {
      if (this.walkToken !== token) return;
      at = k;
      this.goto(idx[k]);
      box.querySelectorAll(".walk-steps li").forEach((li, j) => li.classList.toggle("on", j === k));
      if (step) step.innerHTML = k < idx.length - 1 ? `Next move <svg class="icon"><use href="#i-next"/></svg>`
        : `<svg class="icon"><use href="#i-replay"/></svg>From the start`;
    };
    box.querySelector(".walk-steps").addEventListener("click", (e) => { const b = e.target.closest("[data-k]"); if (b) show(+b.dataset.k); });
    step?.addEventListener("click", () => show(at < idx.length - 1 ? at + 1 : 0));
    return show;
  }

  /** Why their punishment works: one line on what my move allowed, then the engine's follow-up, stepped like the idea. */
  async whyItWorks(cur, replyIdx) {
    const fb = this.els.feedback.querySelector(".fb");
    if (!fb || replyIdx == null) return;
    const token = this.walkToken = {};
    const head = `<p class="label">Why it works · ${esc(this.frames[replyIdx].san)}</p>`;
    const box = document.createElement("div");
    box.className = "walk why";
    box.innerHTML = head + `<p class="walk-wait">Working it out…</p>`;
    fb.appendChild(box);
    let line = null;
    try { if (this.analyse) [line] = await this.analyse(this.frames[replyIdx].fen); } catch {}
    if (this.walkToken !== token) return;
    let w;
    try { w = punishment({ after: cur.fen, reply: cur.reply, before: cur.before_fen, played: cur.san, line, mate: cur.mate > 0 ? cur.mate : null }); }
    catch { box.remove(); return; }
    let at = replyIdx;
    const idx = w.steps.map(({ ply }, k) => (k === 0 ? replyIdx : (at = this.addFrame(ply.after, ply.move, at, "pv", numbered(ply.before, ply.move)))));
    this.stepper(box, head, w, idx, token)(0);
    this.showInDrill(this.els.fixGo.hidden ? this.els.next : this.els.fixGo);
  }

  /** The idea behind the engine's move: its line played on the board, a caption per move (or one line if quiet). */
  async walk(cur) {
    const fb = this.els.feedback.querySelector(".fb");
    if (!fb || !cur.better || !cur.before_fen) return;
    const token = this.walkToken = {};
    const head = `<p class="label">The idea · ${esc(num(cur.move, this.meW(), cur.better))}</p>`;
    const box = document.createElement("div");
    box.className = "walk";
    box.innerHTML = head + `<p class="walk-wait">Working it out…</p>`;
    fb.appendChild(box);
    let line = null;
    try {
      const bm = new Chess(cur.before_fen).move(cur.better);
      if (this.analyse) [line] = await this.analyse(bm.after);
    } catch {}
    if (this.walkToken !== token) return;
    let w;
    try { w = walkthrough({ before: cur.before_fen, played: cur.san, reply: cur.reply, better: cur.better, line }); }
    catch { box.remove(); return; }
    // The engine's move (a branch from "before", unless it was the fix just played) and its line become frames.
    let at = this.frames.findIndex((f) => f.parent === this.beforeIdx && f.move?.san === cur.better);
    const idx = w.steps.map(({ ply }, k) => {
      if (k === 0) return at >= 0 ? at : (at = this.addFrame(ply.after, ply.move, this.beforeIdx, "fix", numbered(ply.before, ply.move)));
      return (at = this.addFrame(ply.after, ply.move, at, "pv", numbered(ply.before, ply.move)));
    });
    const show = this.stepper(box, head, w, idx, token);
    // Start from "before" so the engine's move itself is seen.
    if (this.view !== idx[0]) {
      this.goto(this.beforeIdx);
      await sleep(500);
      if (this.walkToken !== token) return;
    }
    show(0);
    this.showInDrill(this.els.next);
  }


  // ---------- shared ----------

  finish() {
    this.step = "done";
    this.liveIdx = null;
    this.els.fixRow.hidden = true;
    this.els.fixGo.hidden = true;
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

  /** "Step 1 of 2 · ..." above the question, so the player knows where they are and what comes next. */
  paintStep() {
    const cur = this.cur, total = cur.kind === "threat" && cur.before_fen && cur.better ? 2 : 1;
    const text = {
      find: `Step 1 of ${total} · Find their reply`,
      found: "Step 1 done · Next: fix your move",
      fix: "Step 2 of 2 · Find a better move",
      done: "Done · Next position when ready",
    }[this.step];
    this.els.step.textContent = text || "";
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

  paintScan() {
    for (const chip of this.els.scan.querySelectorAll("[data-kind]")) {
      const kind = chip.dataset.kind, on = this.lit.has(kind);
      chip.setAttribute("aria-pressed", String(on));
      chip.querySelector("b").textContent = on ? String(this.scan[kind].length) : "?";
    }
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
    this.els.boxes.innerHTML = counts.map((n, i) => `<div title="${i === 0 ? "new" : "box " + i}: ${n}"><i style="height:${Math.round(2 + (22 * n) / max)}px"></i><span>${n}</span></div>`).join("");
  }

  next() {
    this.cur = this.pick();
    if (!this.cur) return;
    const cur = this.cur, [, mo, d] = cur.date.split("-");
    this.game = new Chess(cur.fen);
    this.scan = scanSets(cur.fen);
    this.lit = new Set();
    this.sel = null;
    this.step = "find";
    this.tries = 0;
    this.firstTry = null;
    this.busy = false;
    this.walkToken = null;
    this.badge = null;
    this.setArrows([], null);
    // The line: before my move (when known), then my move.
    this.frames = [];
    let mine = null;
    if (cur.before_fen) { try { mine = new Chess(cur.before_fen).move(cur.san); } catch {} }
    this.beforeIdx = mine ? this.addFrame(cur.before_fen, null, null, null, "") : null;
    this.findIdx = this.addFrame(cur.fen, mine || { from: cur.from, to: cur.to, flags: "", color: cur.color },
      mine ? this.beforeIdx : null, "me", num(cur.move, this.meW(), cur.san));
    this.liveIdx = this.findIdx;
    this.els.meta.innerHTML = `<span>vs ${esc(cur.opp)}</span><span>${+mo}/${+d}</span><span>${RESULT[cur.result] || ""}</span>`;
    this.els.playedLabel.textContent = "You played";
    this.els.played.textContent = num(cur.move, this.meW(), cur.san);
    this.els.question.textContent = `Can ${this.opp()} punish it?`;
    if (this.els.side) this.els.side.textContent = `You play ${this.meW() ? "White" : "Black"}`;
    this.els.board.setAttribute("aria-label", `Chess board, ${this.meW() ? "White" : "Black"} at the bottom`);
    this.els.feedback.innerHTML = "";
    this.note("");
    this.els.scan.hidden = false;
    this.els.actions.hidden = false;
    this.els.reveal.hidden = true;
    this.els.fixRow.hidden = true;
    this.els.next.hidden = true;
    this.els.fixGo.hidden = true;
    this.paintScan();
    this.paintStep();
    this.paintStats();
    // Show the position before my move, then play my move, so it's clear what moved and what it took.
    clearTimeout(this.introTimer);
    if (mine && !reducedMotion()) {
      this.view = this.beforeIdx;
      this.game = new Chess(cur.before_fen);
      this.render();
      this.introTimer = setTimeout(() => { if (this.cur === cur && this.view === this.beforeIdx && this.step === "find") this.goto(this.findIdx); }, INTRO_MS);
    } else {
      this.view = this.findIdx;
      this.render();
    }
  }
}
