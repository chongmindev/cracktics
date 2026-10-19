import { test } from "node:test";
import assert from "node:assert/strict";
import { evalX, material } from "../src/trainer.js";

test("evalX maps pawns onto the bar and pins mates to the end", () => {
  assert.equal(evalX(0), 50);
  assert.equal(evalX(3), 75);
  assert.equal(evalX(-20), 0);
  assert.equal(evalX(-0.5, true), 0);
});

test("material counts White minus Black in pawns", () => {
  assert.equal(material("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"), 0);
  assert.equal(material("4k3/8/8/3n4/8/8/8/3QK3 w - - 0 1"), 6);     // queen vs knight
  assert.equal(material("4k3/8/8/8/8/8/8/4K2r w - - 0 1"), -5);
});
