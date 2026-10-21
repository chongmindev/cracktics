// The material line under the board's panel: which pieces each side has that the other doesn't, drawn as pieces
// ("You ♗♗ · Them ♖ · you +1"), so a rook against bishop and pawn reads differently from a pawn up.
// Shared by Rewind, Openings and Scout.

const ORDER = ["q", "r", "b", "n", "p"];
const VALUE = { q: 9, r: 5, b: 3, n: 3, p: 1 };
const NAME = { q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };

/** Per side, the pieces it has more of than the other ({w: ["b", "p"], b: ["r"]}), and White minus Black in pawns. */
export function imbalance(fen) {
  const n = { w: {}, b: {} };
  for (const ch of fen.split(" ")[0]) {
    const t = ch.toLowerCase();
    if (t in VALUE) { const c = ch === t ? "b" : "w"; n[c][t] = (n[c][t] || 0) + 1; }
  }
  const extra = { w: [], b: [] };
  let diff = 0;
  for (const t of ORDER) {
    const d = (n.w[t] || 0) - (n.b[t] || 0);
    diff += d * VALUE[t];
    for (let i = 0; i < Math.abs(d); i++) extra[d > 0 ? "w" : "b"].push(t);
  }
  return { extra, diff };
}

/** "an extra bishop and 2 extra pawns" */
const words = (ts) => {
  const c = {};
  for (const t of ts) c[t] = (c[t] || 0) + 1;
  const parts = Object.entries(c).map(([t, k]) => k > 1 ? `${k} extra ${NAME[t]}s` : `an extra ${NAME[t]}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
};

/** Paint el with the imbalance of fen, from your side (meW: you're White). */
export function paintMaterial(el, fen, meW) {
  if (!el) return;
  const { extra, diff } = imbalance(fen), me = meW ? "w" : "b", them = meW ? "b" : "w", d = meW ? diff : -diff;
  const pieces = (c) => extra[c].map((t, i) =>
    `<i class="pc mi ${c}${t.toUpperCase()}${i && extra[c][i - 1] === t ? " same" : ""}"></i>`).join("");
  const side = (c, who) => extra[c].length
    ? `<span class="mat-side" title="${who === "You" ? "You have" : "They have"} ${words(extra[c])}">${who}${pieces(c)}</span>` : "";
  const total = d ? `<b>you ${d > 0 ? "+" : "−"}${Math.abs(d)}</b>` : "<b>even</b>";
  el.innerHTML = extra.w.length || extra.b.length
    ? `Material ${side(me, "You")}${side(them, "Them")}${total}`
    : "Material: same pieces";
  el.title = extra.w.length || extra.b.length
    ? [extra[me].length && `You have ${words(extra[me])}.`, extra[them].length && `They have ${words(extra[them])}.`].filter(Boolean).join(" ") +
      ` Counting P1 N3 B3 R5 Q9, ${d ? `you're ${Math.abs(d)} ${d > 0 ? "up" : "down"}` : "that's even"}.`
    : "Both sides have the same pieces.";
}
