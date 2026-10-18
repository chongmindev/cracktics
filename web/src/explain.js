// The idea behind the better move, as a short walkthrough built from the board and one engine line (no AI text):
//   - one line on what the move does about their threat (takes the attacker, blocks, moves the piece away…)
//   - when the engine's line has an idea in it (captures, checks, mate), a caption for each of its next few
//     moves, played on the board one by one, and where material ends up
//   - otherwise just the move and that one line

import { Chess } from "chess.js";

const NAME = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const MAX_LINE = 6;   // plies of the engine line to walk through at most

/** Material on the board, White minus Black, in pawns (P1 N3 B3 R5 Q9). */
export function material(fen) {
  let v = 0;
  for (const ch of fen.split(" ")[0]) {
    const t = ch.toLowerCase();
    if (t in VALUE) v += (ch === t ? -1 : 1) * VALUE[t];
  }
  return v;
}

const b = (s) => `<b>${s}</b>`;
const side = (c) => (c === "w" ? "White" : "Black");

/** "30.Rxe5" / "30…dxe5" for a verbose move played from `fen`. */
export function numbered(fen, m) {
  const [, turn, , , , full] = fen.split(" ");
  return `${full}${turn === "w" ? "." : "…"}${m.san}`;
}

/** Play UCI moves from `fen`; stops at the first illegal one. Returns [{move, fen before, fen after}]. */
function play(fen, ucis) {
  const g = new Chess(fen), out = [];
  for (const u of ucis) {
    const before = g.fen();
    let m;
    try { m = g.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }); } catch { break; }
    out.push({ move: m, before, after: g.fen() });
  }
  return out;
}

/** Cut a line where it goes quiet: after a move that is not a capture or check, with no capture next. */
function quietCut(plies, min = 2) {
  for (let i = min - 1; i < Math.min(plies.length, MAX_LINE); i++) {
    const m = plies[i].move, next = plies[i + 1]?.move;
    if (!m.captured && !m.san.includes("+") && !next?.captured) return plies.slice(0, i + 1);
  }
  return plies.slice(0, MAX_LINE);
}

/** Squares strictly between a and b on a rank, file or diagonal; [] if they don't share a line. */
export function between(a, b) {
  const f1 = a.charCodeAt(0), r1 = +a[1], f2 = b.charCodeAt(0), r2 = +b[1];
  const df = Math.sign(f2 - f1), dr = Math.sign(r2 - r1);
  if (!(f1 === f2 || r1 === r2 || Math.abs(f2 - f1) === Math.abs(r2 - r1))) return [];
  const out = [];
  for (let f = f1 + df, r = r1 + dr; f !== f2 || r !== r2; f += df, r += dr) out.push(String.fromCharCode(f) + r);
  return out;
}

function amount(n) {
  const words = { 1: "a pawn", 2: "two pawns' worth", 3: "a piece", 5: "a rook", 9: "a queen" };
  return words[n] || `${n} pawns' worth`;
}

/** The enemy pieces worth mentioning that the piece on `sq` attacks: knights and up that are undefended or worth more. */
function targets(fen, sq) {
  const g = new Chess(fen), p = g.get(sq);
  if (!p) return [];
  const them = p.color === "w" ? "b" : "w", out = [];
  for (const row of g.board()) for (const x of row) {
    if (!x || x.color !== them || x.type === "p") continue;
    if (!g.attackers(x.square, p.color).includes(sq)) continue;
    if (x.type === "k" || VALUE[x.type] > VALUE[p.type] || !g.attackers(x.square, them).length) out.push(x);
  }
  return out.sort((a, b2) => VALUE[b2.type] - VALUE[a.type]);
}

/** One short caption for a move of the line; `prev` is the move before it. */
function caption(p, prev, me) {
  const m = p.move, mine = m.color === me, who = side(m.color);
  if (m.san.endsWith("#")) return mine ? "Checkmate." : `${who} mates.`;
  const hits = targets(p.after, m.to).filter((x) => x.type !== "k").map((x) => (mine ? "the " : "your ") + NAME[x.type]);
  const verb = (v) => (mine ? v : v + "s");
  const also = hits.length > 1 ? `${verb("fork")} ${hits[0]} and ${hits[1]}` : hits.length ? `${verb("attack")} ${hits[0]}` : "";
  const alsoIng = hits.length > 1 ? `forking ${hits[0]} and ${hits[1]}` : hits.length ? `attacking ${hits[0]}` : "";
  let text;
  if (m.captured && prev?.move.captured && prev.move.to === m.to) text = mine ? "You take back" : `${who} takes back`;
  else if (m.captured) text = mine ? `You take the ${NAME[m.captured]}` : `${who} takes your ${NAME[m.captured]}`;
  else if (m.promotion) text = mine ? `You make a ${NAME[m.promotion]}` : `${who} makes a ${NAME[m.promotion]}`;
  else if (m.san.includes("+")) text = mine ? "Check" : `${who} checks`;
  else if (also) return `${mine ? "You" : who} ${also}.`;
  else return mine ? "A quiet follow-up." : `${who}'s best reply.`;
  if (m.san.includes("+") && !/^Check|checks$/.test(text)) text += " with check";
  return `${text}${alsoIng ? `, ${alsoIng}` : ""}.`;
}

/**
 * before: FEN before my move. played, reply, better: SAN (my move, their punishment, the engine's move).
 * line: engine line after the better move {pv: [uci], cp, mate} (White's view), or null.
 * Returns {reason, idea, steps: [{ply, text}], summary} — steps[0] is the better move, captioned by `reason`.
 * idea is false when the line is just quiet moves: then only the move and its reason are worth showing.
 */
export function walkthrough({ before, played, reply, better, line = null }) {
  const start = new Chess(before), me = start.turn(), opp = me === "w" ? "b" : "w";
  const pm = new Chess(before).move(played), afterPlayed = pm.after;
  let rm = null;
  try { rm = new Chess(afterPlayed).move(reply); } catch {}
  const bm = new Chess(before).move(better), afterBetter = bm.after;
  // Was their reply already there before my move (a threat to deal with), or did my move make it possible?
  let threatBefore = false;
  if (rm) {
    try {
      const f = before.split(" "); f[1] = opp; f[3] = "-";
      threatBefore = new Chess(f.join(" ")).moves({ verbose: true }).some((m) => m.from === rm.from && m.to === rm.to);
    } catch {}
  }

  // What the better move does about their threat, in one line.
  const reasons = [];
  if (bm.san.endsWith("#")) reasons.push("Checkmate.");
  if (bm.captured) reasons.push(rm && bm.to === rm.from
    ? `Takes the ${NAME[bm.captured]} that was going to play ${b(rm.san)}.`
    : `Takes the ${NAME[bm.captured]} on ${bm.to}.`);
  if (!reasons.length && rm?.captured && pm.to === rm.to) {   // my move walked into the capture
    reasons.push(bm.from === pm.from
      ? `Your ${NAME[pm.piece]} goes to ${bm.to} instead of ${pm.to}, where ${b(rm.san)} takes it.`
      : `Keeps your ${NAME[pm.piece]} off ${pm.to}, where ${b(rm.san)} takes it.`);
  }
  if (rm && !reasons.length) {
    const S = rm.to, mine = start.get(S);
    const replyLegal = new Chess(afterBetter).moves({ verbose: true }).some((m) => m.from === rm.from && m.to === S);
    if (!replyLegal && between(rm.from, S).includes(bm.to)) reasons.push(`Blocks the ${NAME[rm.piece]}'s path to ${S}.`);
    else if (rm.captured && start.attackers(S, me).includes(pm.from) && !new Chess(afterPlayed).attackers(S, me).includes(pm.to)
      && new Chess(afterBetter).get(S)?.color === me && new Chess(afterBetter).attackers(S, me).includes(pm.from))
      reasons.push(`Keeps your ${NAME[pm.piece]} guarding ${S}.`);
    else if (rm.captured && mine?.color === me && bm.from === S) reasons.push(`Gets your ${NAME[mine.type]} out of reach of ${b(rm.san)}.`);
    else if (!replyLegal && threatBefore) reasons.push(`Stops ${b(rm.san)}.`);
    else if (replyLegal && rm.captured && new Chess(afterBetter).get(S)?.color === me
      && new Chess(afterBetter).attackers(S, me).length > start.attackers(S, me).length)
      reasons.push(`Defends ${S}, so ${b(rm.san)} loses the ${NAME[rm.piece]}.`);
    else if (replyLegal && rm.san.endsWith("#")) {
      const g = new Chess(afterBetter);
      g.move({ from: rm.from, to: S, promotion: rm.promotion });
      if (!g.isCheckmate()) reasons.push(`Covers the king, so ${b(rm.san.slice(0, -1))} isn't mate.`);
    }
  }
  if (!reasons.length && rm) {   // their reply would also have hit the piece that the better move takes away
    const g = new Chess(afterPlayed);
    g.move({ from: rm.from, to: rm.to, promotion: rm.promotion });
    const moved = start.get(bm.from);
    if (moved && targets(g.fen(), rm.to).some((x) => x.square === bm.from && x.color === me))
      reasons.push(`Gets your ${NAME[moved.type]} away first, so ${b(rm.san)} doesn't hit it.`);
  }
  if (!reasons.length && bm.san.includes("+")) reasons.push(`Check first, so ${side(opp)} has no time for ${rm ? b(rm.san) : "their threat"}.`);
  if (!reasons.length) {
    const hits = targets(afterBetter, bm.to).filter((x) => x.type !== "k");
    if (hits.length) reasons.push(`Attacks the ${NAME[hits[0].type]}, so ${side(opp)} has no time for ${rm ? b(rm.san) : "their threat"}.`);
  }
  if (!reasons.length && rm && !threatBefore) reasons.push(`Without ${b(pm.san)}, ${b(rm.san)} never happens.`);
  if (!reasons.length) reasons.push(rm ? `Takes the sting out of ${b(rm.san)}.` : "Keeps everything protected.");
  const reason = reasons[0];

  // The engine's line, cut where it goes quiet, with a caption per move.
  const plies = [{ move: bm, before, after: afterBetter }, ...play(afterBetter, line?.pv || [])];
  const shown = quietCut(plies, 3);
  const steps = shown.map((p, i) => ({ ply: p, text: i === 0 ? reason : caption(p, shown[i - 1], me) }));
  const sign = me === "w" ? 1 : -1;
  const d = sign * (material(shown.at(-1).after) - material(before));
  const myMate = line?.mate != null && sign * line.mate > 0 ? sign * line.mate + 1 : null;
  const idea = !!myMate || (shown.length >= 3 && (d !== 0 || shown.slice(1).some((p) => p.move.captured || p.move.san.includes("+"))));
  const summary = myMate ? `Mate in ${myMate}.`
    : d > 0 ? `You come out ${amount(d)} up.`
    : d < 0 ? `You give back ${amount(-d)}, but the threat is gone.`
    : "Material stays level, and the threat is gone.";
  return { reason, idea, steps: idea ? steps : steps.slice(0, 1), summary };
}

/**
 * Why their punishment works, in the same shape as walkthrough(): {reason, idea, steps, summary}.
 * after: FEN after my move (their turn). reply: their move (SAN). before, played: FEN before my move and my move
 * (SAN), when known, so the reason can say what my move changed. line: engine line after the reply {pv, cp, mate}.
 * mate: moves to mate for them from `after`, if any.
 */
export function punishment({ after, reply, before = null, played = null, line = null, mate = null }) {
  const A = new Chess(after), opp = A.turn(), me = opp === "w" ? "b" : "w", Opp = side(opp);
  const rm = new Chess(after).move(reply), afterReply = rm.after;
  let B = null, pm = null;
  if (before && played) try { B = new Chess(before); pm = new Chess(before).move(played); } catch { B = pm = null; }
  const defenders = (sq) => A.attackers(sq, me).length;

  let reason;
  if (rm.san.endsWith("#")) reason = "Checkmate.";
  else if (pm && B.get(pm.from)?.color === me && between(rm.from, rm.to).includes(pm.from))
    reason = `Your ${NAME[pm.piece]} on ${pm.from} was in the ${NAME[rm.piece]}'s way; ${b(pm.san)} opened the line to ${rm.to}.`;
  else if (rm.captured) {
    const victim = NAME[rm.captured], check = rm.san.includes("+") ? " And it's check." : "";
    if (pm && rm.to === pm.to && pm.captured && defenders(rm.to) && VALUE[rm.piece] >= VALUE[pm.piece])
      reason = `${Opp} takes back on ${rm.to}; the trouble comes next.${check}`;
    else if (pm && rm.to === pm.to)
      reason = `Your ${NAME[pm.piece]} went to ${rm.to}, where the ${NAME[rm.piece]} takes it` +
        (!defenders(rm.to) ? ", and nothing defends it." : VALUE[rm.piece] < VALUE[rm.captured] ? ": taking back still leaves you down." : ".") + check;
    else if (pm && B.attackers(rm.to, me).includes(pm.from) && !A.attackers(rm.to, me).includes(pm.to))
      reason = `Your ${NAME[pm.piece]} on ${pm.from} was guarding the ${victim}; after ${b(pm.san)} ` +
        (defenders(rm.to) ? "it isn't guarded enough." : "nothing does.") + check;
    else if (!defenders(rm.to)) reason = `Takes your ${victim}, which nothing defends.${check}`;
    else if (VALUE[rm.piece] < VALUE[rm.captured]) reason = `Takes your ${victim} with a ${NAME[rm.piece]}: even if you take back, you're down.${check}`;
    else reason = `Takes your ${victim}.${check}`;
  } else {
    const hits = targets(afterReply, rm.to).filter((x) => x.type !== "k").map((x) => NAME[x.type]);
    if (rm.promotion) reason = `Makes a ${NAME[rm.promotion]}.`;
    else if (rm.san.includes("+")) reason = hits.length ? `Check, and the ${NAME[rm.piece]} also hits your ${hits[0]}.` : "Check.";
    else if (hits.length) reason = `Attacks your ${hits[0]}${hits[1] ? ` and ${hits[1]}` : ""}.`;
    else reason = `${Opp}'s strongest move here.`;
  }

  const plies = [{ move: rm, before: after, after: afterReply }, ...play(afterReply, line?.pv || [])];
  const shown = quietCut(plies, 3);
  const steps = shown.map((p, i) => ({ ply: p, text: i === 0 ? reason : caption(p, shown[i - 1], me) }));
  const sign = me === "w" ? 1 : -1;
  const d = sign * (material(shown.at(-1).after) - material(B ? before : after));
  const idea = mate != null || (shown.length >= 3 && (d !== 0 || shown.slice(1).some((p) => p.move.captured || p.move.san.includes("+"))));
  const summary = mate != null ? `${Opp} mates in ${mate}.`
    : d < 0 ? `${Opp} comes out ${amount(-d)} up.`
    : d > 0 ? `You keep ${amount(d)} more, but ${Opp} is much better.`
    : `Material stays level, but ${Opp} is much better.`;
  return { reason, idea, steps: idea ? steps : steps.slice(0, 1), summary };
}
