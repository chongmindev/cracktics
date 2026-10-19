import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { between, walkthrough, punishment, refutation, threat } from "../src/explain.js";

const plain = (s) => s.replace(/<[^>]+>/g, "");
const SCHOLAR = "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3";   // Black to move, f7 under fire

test("between lists the squares on a shared line", () => {
  assert.deepEqual(between("h5", "f7"), ["g6"]);
  assert.deepEqual(between("a1", "a4"), ["a2", "a3"]);
  assert.deepEqual(between("a1", "b3"), []);
});

test("a quiet fix is just the move and one line", () => {
  const w = walkthrough({ before: SCHOLAR, played: "Nf6", reply: "Qxf7#", better: "g6",
    line: { pv: ["h5f3", "g8f6", "g1e2"], cp: -20, mate: null } });
  assert.equal(plain(w.reason), "Blocks the queen's path to f7.");
  assert.equal(w.idea, false);
  assert.equal(w.steps.length, 1);
});

test("moving the piece out of reach, when a defender walked away", () => {
  const before = "4k3/8/1b6/8/3N4/8/8/3QK3 w - - 0 1";   // Qd1 guards the d4 knight; Bb6 eyes it
  assert.equal(plain(walkthrough({ before, played: "Qb3", reply: "Bxd4", better: "Nf5" }).reason),
    "Gets your knight out of reach of Bxd4.");
});

test("a line with captures is walked through, move by move", () => {
  // White: Ra6 can take the b6 bishop that eyes d4; after Kd7, Nf5 is calm.
  const before = "4k3/8/Rb6/8/3N4/8/8/4K3 w - - 0 1";
  const w = walkthrough({ before, played: "Ra8+", reply: "Kd7", better: "Rxb6",
    line: { pv: ["e8d7", "d4f5"], cp: 900, mate: null } });
  assert.equal(plain(w.reason), "Takes the bishop on b6.");
  assert.equal(w.idea, true);
  assert.deepEqual(w.steps.map((s) => s.ply.move.san), ["Rxb6", "Kd7", "Nf5"]);
  assert.equal(w.steps[1].text, "Black's best reply.");
  assert.equal(w.summary, "You come out a piece up.");
});

test("captions: a fork, then the capture it sets up", () => {
  const before = "4k3/2q5/5r2/8/8/2N5/8/4K3 w - - 0 1";   // Nd5 hits the queen on c7 and the rook on f6
  const w = walkthrough({ before, played: "Kd2", reply: "Rf2+", better: "Nd5",
    line: { pv: ["c7c6", "d5f6"], cp: 900, mate: null } });
  assert.equal(plain(w.reason), "Attacks the queen, so Black has no time for Rf2+.");
  assert.equal(w.steps[2].text, "You take the rook with check.");
});

test("punishment: says what my move gave up, then walks the line", () => {
  const before = "r3kb1r/pppb1ppp/1q3n2/1N2p3/1PPpP3/3P1N2/P2B1PPP/R2Q1RK1 w kq - 0 12";
  const after = "r3kb1r/pppb1ppp/1q3n2/1NP1p3/1P1pP3/3P1N2/P2B1PPP/R2Q1RK1 b kq - 0 12";
  const w = punishment({ after, reply: "Qxb5", before, played: "c5", line: { pv: ["a2a4", "b5b4"] } });
  assert.equal(w.reason, "Your pawn on c4 was guarding the knight; after <b>c5</b> nothing does.");
  assert.deepEqual(w.steps.map((s) => s.ply.move.san), ["Qxb5", "a4", "Qxb4"]);
  assert.equal(w.steps[1].text, "You attack the queen.");
  assert.ok(w.idea);
  assert.equal(w.summary, "Black comes out 4 pawns' worth up.");
});

test("punishment: an opened line, and a quiet follow-up shows just the move", () => {
  const before = "r5k1/p3p2p/1qp2bp1/1pQp4/4p2P/6P1/PPP2P2/1K1RR3 w - - 2 22";
  const after = "r5k1/p3p2p/1qp2bp1/1p1p4/1Q2p2P/6P1/PPP2P2/1K1RR3 b - - 3 22";
  const w = punishment({ after, reply: "Qxf2", before, played: "Qb4" });
  assert.equal(w.reason, "Your queen on c5 was in the queen's way; <b>Qb4</b> opened the line to f2.");
  assert.equal(w.steps.length, 1);
});

test("refutation: what their habit gives you, then your reply and the line", () => {
  const before = "rnbqkbnr/ppp1pppp/3p4/8/4P3/5Q2/PPPP1PPP/RNB1KBNR b KQkq - 1 2";   // 1.e4 d6 2.Qf3, Black to move
  const w = refutation({ before, habit: "Bg4", line: { pv: ["f3g4", "e7e5"], cp: 320 } });
  assert.equal(plain(w.reason), "Their bishop goes to g4, where your queen takes it, and nothing defends it.");
  assert.deepEqual(w.steps.map((s) => s.ply.move.san), ["Bg4", "Qxg4", "e5"]);
  assert.equal(w.steps[1].text, "You take their bishop. You're a piece up.");
  assert.equal(w.summary, "You come out a piece up.");
});

test("refutation: a habit that allows mate", () => {
  const w = refutation({ before: SCHOLAR, habit: "Nf6", line: { pv: ["h5f7"], mate: 1 } });
  assert.equal(plain(w.reason), "Allows Qxf7#, mate.");
  assert.equal(w.summary, "Mate in 1.");
});

test("refutation: the full line says why each move is played", () => {
  const g = new Chess();
  "e4 e5 Nf3 Nc6 Bc4 Nf6 Ng5 d5 exd5".split(" ").forEach((m) => g.move(m));
  const w = refutation({ before: g.fen(), habit: "Nxd5",
    line: { pv: ["g5f7", "e8f7", "d1f3", "f7e6", "b1c3", "c6b4", "f3e4", "c7c6", "a2a3"], cp: 150 } });
  assert.equal(plain(w.reason), "Lets your knight take their pawn on f7 and hit their queen on d8.");
  assert.deepEqual(w.steps.slice(1).map((s) => [s.ply.move.san, plain(s.text)]), [
    ["Nxf7", "You take their pawn, and threaten to win their queen on d8."],
    ["Kxf7", "Black takes back. You're two pawns' worth down for now."],
    ["Qf3+", "You give check, and threaten to win their knight on d5."],
    ["Ke6", "Black gets out of check."],
    ["Nc3", "You threaten to win their knight on d5."],
    ["Nb4", "Black defends their knight on d5."],
  ]);
});

test("threat: counts the exchange, so a piece attacked twice and defended once is won", () => {
  const fen = "r1bq1b1r/ppp2kpp/2n5/3np3/2B5/5Q2/PPPP1PPP/RNB1K2R b KQ - 2 6";   // after 6.Qf3+ in the line above
  assert.deepEqual((({ to, captured, gain }) => ({ to, captured, gain }))(threat(fen, "w")), { to: "d5", captured: "n", gain: 3 });
  assert.equal(threat(fen, "b"), null);
});

test("openingMiss: what's wrong with an opening move, without naming the right one", async () => {
  const { openingMiss } = await import("../src/explain.js");
  // 1.e4 e5 2.Qh5: early queen, and Nc6 isn't even needed to hit it (Nf6 does).
  let r = openingMiss({ path: ["e4", "e5"], played: "Qh5", reply: "Nf6" });
  assert.match(r.reasons[0], /queen out early, and <b>Nf6<\/b> hits it/);
  assert.equal(r.walk.steps[0].ply.move.san, "Nf6");
  // 1.e4 e5 2.Nf3 Nc6 3.Ng5: the knight again, with three pieces still at home.
  r = openingMiss({ path: ["e4", "e5", "Nf3", "Nc6"], played: "Ng5" });
  assert.match(r.reasons[0], /knight a second time while 3 pieces still sit at home/);
  // 1.e4 e5 2.Bd3 blocks the d-pawn.
  r = openingMiss({ path: ["e4", "e5"], played: "Bd3" });
  assert.ok(r.reasons.some((x) => /in front of your d-pawn/.test(x)));
  // 1.e4 e5 2.f3: the king's diagonal.
  r = openingMiss({ path: ["e4", "e5"], played: "f3" });
  assert.ok(r.reasons.some((x) => /e1 to h4/.test(x)));
  // 1.e4 e6 2.d4 b6: a flank pawn while the pieces wait.
  r = openingMiss({ path: ["e4", "e6", "d4"], played: "b6" });
  assert.match(r.reasons[0], /pawn move on the edge/);
  // A quiet centre move: nothing to say from the board alone.
  r = openingMiss({ path: ["e4", "e5", "Nf3", "Nc6"], played: "c3" });
  assert.deepEqual(r.reasons, []);
});
