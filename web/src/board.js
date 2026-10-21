// A board for showing positions: pieces, the last move, coordinates and arrows. Same squares, pieces and arrows as
// the drill (styles/app.css), without its animations. With `onTap` the squares are buttons, for playing a move.

import { Chess } from "chess.js";
import { paintMaterial } from "./material.js";

const FILES = "abcdefgh";
const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

export class Board {
  /** el: the .board grid; arrows: the svg.arrows over it. */
  constructor(el, arrows) {
    Object.assign(this, { el, arrows });
    this.white = true;
  }

  sq(r, c) { return this.white ? FILES[c] + (8 - r) : FILES[7 - c] + (r + 1); }
  xy(s) { const f = FILES.indexOf(s[0]), r = +s[1]; return this.white ? [f + 0.5, 8 - r + 0.5] : [7 - f + 0.5, r - 1 + 0.5]; }

  /**
   * fen; last: {from, to} or null; arrows: [{from, to, weight 0..1, kind}] drawn heaviest last.
   * To play on it: onTap(square), sel (the selected square), targets (squares it can move to), marks {square: "ok"|"no"}.
   */
  draw(fen, { last = null, arrows = [], onTap = null, sel = null, targets = [], marks = {} } = {}) {
    const g = new Chess(fen);
    this.el.replaceChildren();
    for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
      const s = this.sq(r, c), p = g.get(s), d = document.createElement(onTap ? "button" : "div");
      d.className = "sq" + ((FILES.indexOf(s[0]) + +s[1]) % 2 === 1 ? " d" : "") + (sel === s ? " sel" : "");
      if (onTap) { d.type = "button"; d.dataset.sq = s; d.addEventListener("click", () => onTap(s)); }
      else d.setAttribute("role", "gridcell");
      d.setAttribute("aria-label", s + (p ? ` ${p.color === "w" ? "white" : "black"} ${NAME[p.type]}` : ""));
      const add = (cls, text) => { const x = document.createElement("span"); x.className = cls; if (text) x.textContent = text; d.appendChild(x); };
      if (last && (s === last.from || s === last.to)) add("lm");
      if (c === 0) add("coord r", s[1]);
      if (r === 7) add("coord f", s[0]);
      if (p) add(`pc ${p.color}${p.type.toUpperCase()}`);
      if (targets.includes(s)) add("target");
      if (marks[s]) {
        const v = document.createElement("span");
        v.className = `verdict ${marks[s]}`;
        v.innerHTML = `<svg class="icon"><use href="#i-${marks[s] === "ok" ? "check" : "x"}"/></svg>`;
        d.appendChild(v);
      }
      this.el.appendChild(d);
    }
    paintMaterial(this.material, fen, this.white);   // the material line, if the page gave the board one
    this.arrows.innerHTML = [...arrows].sort((a, b) => a.weight - b.weight).map((a) => this.arrow(a)).join("");
  }

  arrow({ from, to, weight = 1, kind = "" }) {
    const [x1, y1] = this.xy(from), [x2, y2] = this.xy(to);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
    const w = 0.08 + 0.12 * weight, head = 0.16 + 0.12 * weight;
    const ex = x2 - ux * 0.32, ey = y2 - uy * 0.32, hx = x2 - ux * 0.12, hy = y2 - uy * 0.12;
    const px = -uy * head, py = ux * head, bx = x2 - ux * 0.45, by = y2 - uy * 0.45;
    return `<g class="${kind}" opacity="${(0.35 + 0.65 * weight).toFixed(2)}"><line x1="${x1}" y1="${y1}" x2="${ex}" y2="${ey}" stroke-width="${w.toFixed(3)}"/>` +
      `<polygon points="${hx},${hy} ${bx + px},${by + py} ${bx - px},${by - py}"/></g>`;
  }
}
