// Builds src/openings.json from the Lichess opening list (https://github.com/lichess-org/chess-openings, CC0):
// position (FEN without move counters) -> [eco, name]. Keyed by position, so a transposition gets its name too.
// Usage: node tools/openings.mjs <dir with a.tsv … e.tsv>
import { readFileSync, writeFileSync } from "node:fs";
import { Chess } from "chess.js";

const dir = process.argv[2];
const out = {};
for (const f of ["a", "b", "c", "d", "e"]) {
  for (const row of readFileSync(`${dir}/${f}.tsv`, "utf8").trim().split("\n").slice(1)) {
    const [eco, name, pgn] = row.split("\t");
    const g = new Chess();
    for (const san of pgn.replace(/\d+\.\s*/g, "").split(/\s+/).filter(Boolean)) g.move(san);
    const key = g.fen().split(" ").slice(0, 4).join(" ");
    if (!out[key] || out[key][1].length > name.length) out[key] = [eco, name];   // shortest name for a shared position
  }
}
writeFileSync(new URL("../src/openings.json", import.meta.url), JSON.stringify(out));
console.log(Object.keys(out).length, "positions");
