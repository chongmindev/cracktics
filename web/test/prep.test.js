import { test } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { buildTree, byFamily, habits, keyOf, kidsOf, lineOf, mainLine, numberLine, predictability, rankPlans, road, score, weakSpots } from "../src/prep.js";

/** A game seen from the opponent ("their" colour), from SAN moves. */
function game(sans, color, result) {
  const c = new Chess();
  return { color, result, link: `g${Math.random()}`, moves: sans.split(" ").map((s) => { const m = c.move(s); return { from: m.from, to: m.to }; }) };
}
const after = (sans) => { const c = new Chess(); for (const s of sans.split(" ")) c.move(s); return keyOf(c.fen()); };
const names = { [after("e4")]: ["B00", "King's Pawn Game"], [after("e4 c5")]: ["B20", "Sicilian Defense"],
  [after("e4 e5")]: ["C20", "King's Pawn Game"], [after("d4")]: ["A40", "Queen's Pawn Game"] };

// They are Black: always 1...c5 against 1.e4 (and they do well), 1...e5 once; against 1.d4 they lose.
const games = [
  game("e4 c5 Nf3 d6", "b", "win"), game("e4 c5 Nf3 d6", "b", "win"), game("e4 c5 Nc3 Nc6", "b", "draw"),
  game("e4 e5 Nf3 Nc6", "b", "loss"),
  game("d4 d5 c4 e6", "b", "loss"), game("d4 d5 c4 c6", "b", "loss"), game("d4 Nf6 c4 e6", "b", "loss"),
];
const tree = buildTree(games, { plies: 4, names });

test("the tree counts games and results per move, from their side", () => {
  assert.equal(tree.root.n, 7);
  const e4 = tree.root.kids.get("e4"), c5 = e4.kids.get("c5");
  assert.deepEqual([e4.n, c5.n, c5.w, c5.d, c5.l], [4, 3, 2, 1, 0]);
  assert.equal(c5.name, "Sicilian Defense");
  assert.equal(c5.kids.get("Nf3").name, "Sicilian Defense");   // unnamed positions inherit the opening's name
  assert.deepEqual(lineOf(c5.kids.get("Nf3")), ["e4", "c5", "Nf3"]);
  assert.equal(numberLine(["e4", "c5", "Nf3"]), "1.e4 c5 2.Nf3");
  assert.deepEqual(kidsOf(e4).map((k) => k.san), ["c5", "e5"]);
});

test("weak spots are lines you can steer into where they score well below their usual", () => {
  const w = weakSpots(tree, "b", { minGames: 3, gap: 0.12, max: 5 });
  assert.deepEqual(w.map((x) => lineOf(x.node).join(" ")), ["d4"]);   // 0% in 3 games vs ~36% overall
  assert.equal(score(w[0].node), 0);
});

test("habits, main line, predictability and openings", () => {
  const h = habits(tree, "b", { minGames: 3, minShare: 0.5 });
  assert.deepEqual(h.map((x) => lineOf(x.move).join(" ")), ["e4 c5", "d4 d5"]);
  assert.deepEqual(mainLine(tree).map((n) => n.san), ["e4", "c5", "Nf3", "d6"]);
  assert.ok(predictability(tree, "b") > 0.6);
  assert.deepEqual(byFamily(tree, { minGames: 1 }).map((f) => [f.family, f.n]),
    [["Sicilian Defense", 3], ["Queen's Pawn Game", 3], ["King's Pawn Game", 1]]);
});

test("road: their shares along the way, and the odds they follow it", () => {
  const g = (moves, result = "loss") => ({ color: "b", result, moves });
  const tree = buildTree([g(["e4", "e5", "Nf3", "Nc6"]), g(["e4", "e5", "Nf3", "d6"]), g(["e4", "c5"]), g(["d4", "d5"])]);
  const e4 = tree.root.kids.get("e4"), e5 = e4.kids.get("e5"), nc6 = e5.kids.get("Nf3").kids.get("Nc6");
  const r = road(nc6, "b");
  assert.deepEqual(r.steps.map((s) => [s.node.san, s.theirs]), [["e4", false], ["e5", true], ["Nf3", false], ["Nc6", true]]);
  assert.equal(r.odds, (2 / 3) * (1 / 2));
  const plans = rankPlans([{ node: e5.kids.get("Nf3"), move: nc6, loss: 900 }, { node: e4, move: e5, loss: 100 }], "b", { lossCap: 500 });
  assert.deepEqual(plans.map((p) => p.move.san), ["Nc6", "e5"]);   // 1/3 * 500 > 2/3 * 100
});
