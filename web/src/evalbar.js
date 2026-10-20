// The eval bar beside the board: a strip, White's share from White's end, so who's better (and by how much) shows
// at a glance; the number sits in the page as text, from your side ("you +1.2"). Shared by Rewind and Openings.

/** White's share of the bar, 0..1, for an eval from White's view (cp, or mate in moves: + White mates). */
export function whiteShare(cp, mate = null) {
  if (mate) return mate > 0 ? 1 : 0;
  return 1 / (1 + Math.exp(-0.004 * (cp || 0)));   // +1 pawn ≈ 60%, +3 ≈ 77%, +6 ≈ 92%
}

/** "+1.2", "−0.4", "0.0", "#3" (you mate in 3), "−#2" (you get mated): cp and mate from your side. */
export function evalText(cp, mate = null) {
  if (mate) return mate > 0 ? `#${mate}` : `−#${-mate}`;
  const v = Math.abs(cp || 0) / 100;
  return `${cp > 0 ? "+" : cp < 0 ? "−" : ""}${v.toFixed(1)}`;
}

/** Plain words for an eval from your side. */
export function evalWords(cp, mate = null) {
  if (mate) return mate > 0 ? `you have mate in ${mate}` : `you get mated in ${-mate}`;
  const p = Math.abs(cp || 0) / 100, who = cp > 0 ? "you're" : "they're";
  return p < 0.5 ? "about equal" : p < 1.5 ? `${who} a little better` : p < 3 ? `${who} clearly better` : `${who} winning`;
}

export class EvalBar {
  /** box: the board's frame (the bar hangs off its left edge); label: an element for the text, or null. */
  constructor(box, label = null) {
    this.el = document.createElement("div");
    this.el.className = "evalbar-v";
    this.el.setAttribute("role", "img");
    this.el.innerHTML = `<i class="fill"></i><i class="mid"></i>`;
    box.appendChild(this.el);
    this.label = label;
    this.clear();
  }

  /** cp and mate from White's view; meWhite: White at the bottom. Null cp and mate: unknown (the bar goes grey). */
  set(cp, mate, meWhite) {
    if (cp == null && !mate) return this.clear(true);
    const w = whiteShare(cp, mate), mine = meWhite ? w : 1 - w, sign = meWhite ? 1 : -1;
    const myCp = cp == null ? null : sign * cp, myMate = mate ? sign * mate : null;
    this.el.hidden = false;
    this.el.classList.remove("pending");
    this.el.classList.toggle("black-bottom", !meWhite);
    this.el.style.setProperty("--share", `${(100 * mine).toFixed(1)}%`);   // the bottom part: your colour
    const text = evalText(myCp, myMate), words = evalWords(myCp, myMate);
    this.el.title = `Engine eval for you: ${text}, ${words}. +1 is about a pawn's worth.`;
    this.el.setAttribute("aria-label", this.el.title);
    if (this.label) this.label.innerHTML = `Eval: you <b>${text}</b> <span class="words">· ${words}</span>`;
  }

  /** No eval to show: hidden, or (pending) grey and kept in place while the engine works. */
  clear(pending = false) {
    this.el.hidden = !pending;
    this.el.classList.toggle("pending", pending);
    if (this.label) this.label.innerHTML = pending ? "Eval: …" : "";
  }
}
