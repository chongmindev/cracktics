// Copies the site into dist/: page, sources, chess.js and the lite engine. No bundler.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const out = new URL("./dist/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(new URL("vendor/", out), { recursive: true });
mkdirSync(new URL("engine/", out), { recursive: true });
cpSync(new URL("./index.html", import.meta.url), new URL("index.html", out));
cpSync(new URL("./favicon.svg", import.meta.url), new URL("favicon.svg", out));
cpSync(new URL("./scout/", import.meta.url), new URL("scout/", out), { recursive: true });
cpSync(new URL("./openings/", import.meta.url), new URL("openings/", out), { recursive: true });   // page and book.json
cpSync(new URL("./prep/", import.meta.url), new URL("prep/", out), { recursive: true });   // old address: redirects to scout/
cpSync(new URL("./src/", import.meta.url), new URL("src/", out), { recursive: true });
cpSync(new URL("./styles/", import.meta.url), new URL("styles/", out), { recursive: true });
cpSync(new URL("./node_modules/chess.js/dist/esm/chess.js", import.meta.url), new URL("vendor/chess.js", out));
cpSync(new URL("./node_modules/chess.js/LICENSE", import.meta.url), new URL("vendor/chess.js.LICENSE.txt", out));
for (const f of ["stockfish-19-lite-single.js", "stockfish-19-lite-single.wasm"])
  cpSync(new URL(`./node_modules/stockfish/bin/${f}`, import.meta.url), new URL(`engine/${f}`, out));
cpSync(new URL("./node_modules/stockfish/Copying.txt", import.meta.url), new URL("engine/COPYING.txt", out));

// Pieces: the cburnett set (Colin M.L. Burnett; GPLv2+/BSD/GFDL), as embedded in chessground's stylesheet.
// Written as pieces/wP.svg ... pieces/bK.svg.
const LETTER = { pawn: "P", knight: "N", bishop: "B", rook: "R", queen: "Q", king: "K" };
const css = readFileSync(new URL("./node_modules/chessground/assets/chessground.cburnett.css", import.meta.url), "utf8");
mkdirSync(new URL("pieces/", out), { recursive: true });
let pieces = 0;
for (const m of css.matchAll(/piece\.(\w+)\.(white|black)\s*\{\s*background-image:\s*url\('data:image\/svg\+xml;base64,([^']+)'\)/g)) {
  writeFileSync(new URL(`pieces/${m[2][0]}${LETTER[m[1]]}.svg`, out), Buffer.from(m[3], "base64"));
  pieces++;
}
if (pieces !== 12) throw new Error(`expected 12 piece images, found ${pieces}`);
writeFileSync(new URL("pieces/LICENSE.txt", out),
  "Chess pieces by Colin M.L. Burnett (cburnett), licensed GPLv2+ (also BSD and GFDL),\n" +
  "as distributed with chessground (https://github.com/lichess-org/chessground).\n");
writeFileSync(new URL("_headers", out), [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: strict-origin-when-cross-origin",
  "/engine/*",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n"));
console.log("built", out.pathname);
