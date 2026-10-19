// How big each opening's quest is with the current book and [openings] settings: lines, and their moves by kind.
// Usage: node tools/quest-stats.mjs [opening name...]
import { readFileSync } from "node:fs";
import { candidates, families, kidsOf, questTree } from "../src/quest.js";

const cfg = JSON.parse(readFileSync(new URL("../src/config.json", import.meta.url), "utf8")).openings;
const book = JSON.parse(readFileSync(new URL("../openings/book.json", import.meta.url), "utf8")).root;
const want = process.argv.slice(2);
const fams = families(book).filter((f) => (want.length ? want.includes(f.name) : f.n >= book.n * 0.0005));
const rows = [{ name: "Every opening (White)", path: [], side: "w" }, { name: "Every opening (Black)", path: [], side: "b" }, ...fams];
for (const f of rows) {
  const t0 = Date.now(), { leaves, count } = questTree(book, f.path, f.side, cfg, cfg.book_plies);
  const depth = leaves.length ? Math.round(leaves.reduce((a, l) => a + l.length, 0) / leaves.length) : 0;
  console.log(`${f.name.padEnd(36)} ${f.side} lines ${String(leaves.length).padStart(5)}  avg plies ${String(depth).padStart(2)}  ` +
    `common ${count.common} best ${count.best} slip ${count.slip} trap ${count.trap}  ${Date.now() - t0}ms`);
}
