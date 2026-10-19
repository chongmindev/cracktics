import { test } from "node:test";
import assert from "node:assert/strict";
import { candidates, chooseMove, families, nameAt, pathKey, questTree, rankText, repertoire } from "../src/quest.js";

const cfg = { answer_tolerance: 40, side_min_share: 0.04, side_max: 5, trap_max_loss: 50, trap_reply_loss: 120, trap_min_share: 0.002 };

// A tiny book: 1.e4 d5 (Scandinavian) and what White plays next, with evals (White's view).
const leaf = (n, e) => ({ n, r: [n / 2, 0, n / 2], e });
const book = {
  n: 1000, r: [500, 0, 500], e: 20,
  k: {
    e4: { n: 900, r: [450, 0, 450], e: 30, k: {
      d5: { n: 300, r: [150, 0, 150], e: 40, o: ["B01", "Scandinavian Defense"], k: {
        exd5: { n: 240, r: [120, 0, 120], e: 40, k: {
          Qxd5: { n: 150, r: [75, 0, 75], e: 50, o: ["B01", "Scandinavian Defense: Mieses-Kotroc Variation"], k: { Nc3: leaf(140, 50) } },
          Nf6: { n: 80, r: [40, 0, 40], e: 45, k: { d4: leaf(70, 45) } },
          c6: { n: 10, r: [5, 0, 5], e: 200 },            // a slip: costs Black 1.6, rare
        } },
        e5: { n: 40, r: [20, 0, 20], e: 10, o: ["B01", "Scandinavian Defense: Advance"], k: {
          Bf5: leaf(30, 15),
        } },
        Nc3: { n: 12, r: [6, 0, 6], e: 0, k: {               // a trap: fine for White, but the most played answer loses
          d4: { n: 8, r: [4, 0, 4], e: 150 },
          dxe4: leaf(4, 0),
        } },
        Qh5: { n: 8, r: [4, 0, 4], e: -150 },                // a slip by White, rare
      } },
      e5: { n: 600, r: [300, 0, 300], e: 30, o: ["C20", "King's Pawn Game"] },
    } },
    d4: { n: 100, r: [50, 0, 50], e: 20, o: ["A40", "Queen's Pawn Game"] },
  },
};

test("candidates: the common moves, the best, slips and traps, each with why", () => {
  const cs = candidates(book.k.e4.k.d5, "w", cfg);
  const kinds = Object.fromEntries(cs.map((c) => [c.san, c.kinds]));
  assert.deepEqual(kinds.exd5, ["common", "best"]);
  assert.deepEqual(kinds.e5, ["common"]);
  assert.deepEqual(kinds.Nc3, ["common", "trap"]);
  assert.equal(cs.find((c) => c.san === "Nc3").trap, "d4");
  assert.equal(kinds.Qh5, undefined, "a rare slip (under side_min_share) isn't worth a line");
  assert.equal(rankText(cs[0]), "the most played move (80%)");
  assert.equal(rankText(cs.find((c) => c.san === "Nc3")), "the 3rd most played (4%)");
});

test("repertoire: the most played move that is good enough, else the engine's", () => {
  assert.equal(repertoire(book.k.e4.k.d5.k.exd5, "b", ["e4", "d5", "exd5"], cfg).san, "Qxd5");
  const nd = { n: 10, e: 0, b: "d7d5", k: { e6: { n: 9, e: 200 } } };    // the only book move loses: the engine's move
  assert.deepEqual(repertoire(nd, "b", ["e4"], cfg), { san: "d5", node: null, loss: 0 });
});

test("questTree: one line per leaf, following your repertoire and every candidate of theirs", () => {
  const { leaves, count } = questTree(book, ["e4", "d5"], "b", cfg);
  assert.deepEqual(leaves.map(pathKey), [
    "e4 d5 exd5 Qxd5 Nc3",      // the book ends after White's reply
    "e4 d5 e5 Bf5",
    "e4 d5 Nc3 dxe4",           // the trap: the repertoire answer is dxe4, not the popular d4
  ]);
  assert.deepEqual(count, { common: 4, best: 2, slip: 0, trap: 1 });
});

test("families: each opening at its first, most played position, with the side that chose it", () => {
  const fs = families(book);
  assert.deepEqual(fs.map((f) => [f.name, pathKey(f.path), f.side]), [
    ["King's Pawn Game", "e4 e5", "b"], ["Scandinavian Defense", "e4 d5", "b"], ["Queen's Pawn Game", "d4", "w"]]);
  assert.deepEqual(nameAt(book, ["e4", "d5", "exd5", "Qxd5", "Nc3"]), ["B01", "Scandinavian Defense: Mieses-Kotroc Variation"]);
});

test("chooseMove: unfinished lines first, then the worst-answered", () => {
  const leaves = [["e4", "d5", "exd5", "Qxd5", "Nc3"], ["e4", "d5", "e5", "Bf5"], ["e4", "d5", "Nc3", "dxe4"]];
  const cs = candidates(book.k.e4.k.d5, "w", cfg);
  const done = { "e4 d5 exd5 Qxd5 Nc3": true, "e4 d5 e5 Bf5": true };
  assert.equal(chooseMove(cs, ["e4", "d5"], leaves, { done }).san, "Nc3");
  const all = { ...done, "e4 d5 Nc3 dxe4": true };
  assert.equal(chooseMove(cs, ["e4", "d5"], leaves, { done: all, boxes: { "e4 d5 e5 Bf5": 1, "e4 d5 exd5 Qxd5 Nc3": 3, "e4 d5 Nc3 dxe4": 2 } }).san, "e5");
});
