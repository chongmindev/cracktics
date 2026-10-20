# Design: Minimalist Monochrome, one indigo accent

An analysis tool should read like a printed analysis: black ink, white paper, serif type, ruled lines.
Cracktics is styled as an editorial chess page with a single pastel-indigo accent. The accent is
where the eye should go: the board, the move you played, the scan chips you switch on, the reply that
punishes you, and progress. Everything else is black and white, and every state is also said in words
or shape, never by color alone.

Words were cut in favor of interface (2026-10-15): the prompt is a move chip and a five-word question,
the scan steps are chips that light the board, and feedback is move cards plus an eval bar.

Replaced Industrial Skeuomorphism on 2026-10-15: monochrome suits analysis, and it frees enough
space for the whole app to fit one screen.

## Files

| File | Holds |
|---|---|
| `styles/tokens.css` | colors, line weights, type, timing, layout constants. The only place raw values live. |
| `styles/app.css` | components, from tokens only |
| `index.html` | markup and the icon sprite |
| `src/app.js`, `src/trainer.js` | behavior; they set `body[data-view]`, `data-state`, `hidden`, and progress widths only |

## One screen

On a desktop (1024px wide and 700px tall or more) the whole app fits the window with no page scroll:

```
+-- bar: wordmark ................................ export  import  sound  theme --+  4px rule
|                                 |  username ______________  from the last _  |
|                                 |  [RAPID][blitz][bullet][daily]  [SCAN ->]  |
|   stage: hero type,             |  [] status text ............               |
|   then the board                |  ---------------- progress rule            |
|   (square, sized to             |  ######## counters + review boxes ######## |  inverted band
|    the window height)           |  ========================================= |  4px rule
|                                 |  meta / meta / meta                        |
|                                 |  Prompt in Playfair                        |
|                                 |  01 02 03 steps  or  feedback              |
|                                 |  [actions]  or  [NEXT ->]                  |
|                                 |  footer line                               |
+---------------------------------+--------------------------------------------+
```

- The stage is a square of about 90% of the available height (capped at 52% of the width), centered; the
  layout is capped at 1280px so the page doesn't sprawl.
- On the intro screen the form and how-it-works are centered vertically between the bar and the footer.
- Views on `body[data-view]`: `intro` shows the hero and "How it works"; `waiting` shows the hero and
  a waiting line; `drill` swaps the hero for the board and shows counters and the drill.
- Once a deck exists, the form collapses to one summary line ("Dudacio · rapid · 2 mo  CHANGE").
- When an answer is shown, the three scan steps hide to make room for the feedback.
- The drill area scrolls internally as a last resort; nothing overlaps at any height.
- Checked at 1470×745: intro, drill and answered states all measure exactly the window height.
- Below 1024px wide the page stacks (board first) and scrolls normally.

## Color

| Token | Value | Use |
|---|---|---|
| `--white` | `#ffffff` | paper |
| `--black` | `#000000` | ink, borders, fills, the inverted band, focus |
| `--ink-muted` | `#525252` | labels and secondary text (7.8:1) |
| `--hairline-color` | `#e5e5e5` | hairline dividers, the empty progress track |
| `--accent-wash` | `#eef0fd` | light squares, the played-move chip, chip hover |
| `--accent-soft` | `#c5c9f4` | dark squares, the eval bar's swing |
| `--accent-mid` | `#9aa0ec` | last-move tint |
| `--accent` | `#5a5fd6` | active chips, the punishing-reply card, progress, step numbers, highlights (5.2:1) |

The accent never carries meaning alone: active chips also show their count, the key card is labelled,
and right/wrong is a word plus inversion/frame and a solid/dashed arrow.

## Night mode

One icon button in the bar (moon by day, sun by night; labelled for screen readers) swaps the theme; the choice is saved in the browser, and with
none saved the system setting decides. An inline script in `<head>` applies it before first paint.

Components never name a color directly: they use `--paper` and `--ink` (which swap), `--tint` for
interface washes, `--sq-light` / `--sq-dark` for the board, `--board-mark` for marks on the board, and
`--coord-light` / `--coord-dark` for coordinates. Night values:

| Token | Day | Night | Why |
|---|---|---|---|
| `--paper` / `--ink` | `#fff` / `#000` | `#0e0e10` / `#f2f2f2` | the swap; the inverted counter band becomes light |
| `--ink-muted` | `#525252` | `#a3a3a3` | 7.9:1 on night paper |
| `--accent` | `#5a5fd6` | `#8f95ff` | lighter, 7.1:1 on night paper |
| `--tint` | `#eef0fd` | `#23254a` | a light wash under light night ink would be unreadable |
| `--sq-light` / `--sq-dark` | `#eef0fd` / `#c5c9f4` | `#9ea3e3` / `#6e74c6` | mid-tone at night so both piece colors read |
| `--board-mark` | `--accent` | `#ffffff` | indigo marks vanish on indigo squares |

## Lines

| Token | Weight | Used for |
|---|---|---|
| `--hairline` | 1px `#e5e5e5` | dividers in "How it works", footer rule |
| `--thin` | 1px black | toggles, links |
| `--medium` | 2px black | buttons, input underlines, board frame, miss feedback, status mark |
| `--thick` | 4px black | the bar's rule, the rule above the drill, hint outlines, the hero rule |
| `--ultra` | 8px black | the left edge of a missed answer |

## Type

- The hero's three lines are each fitted to the stage width by `fitHero()` in `app.js` (and shrunk together
  if the block is too tall), so *before* (bold italic, accent) becomes the graphic word that fills the square.
- **Playfair Display** for display: wordmark (italic), hero, prompt, counters, feedback headings
  (italic), step numbers in "How it works".
- **Source Serif 4** for prose.
- **JetBrains Mono** for labels, moves, inputs, buttons and status: 12–13px, uppercase, 0.1em tracking.
- The hero scales with both width and height (`min(8vw, 11vh)`, up to 8rem) so it always fits its square;
  *before* is set larger, in italic, as the graphic word.
- Moves (`.mv`) are mono with a 2px underline, so notation reads as data inside serif prose.

## The board

| Thing | Look |
|---|---|
| squares | solid `--accent-wash` and `--accent-soft` (no hatching: it made pieces hard to read) |
| pieces | the cburnett set (Colin M.L. Burnett, GPLv2+/BSD/GFDL), extracted from `chessground@9.2.1` at build time into `pieces/*.svg` |
| last move | 3px `--accent` inset frame on both squares, no fill (a tint vanished on the indigo dark squares) |
| selected piece | 4px black inset frame |
| legal targets | thin dark inset frame on each target square (no center dots); thicker on hover |
| Checks / Captures chip on | an accent corner flag on each move's from and to squares |
| Loose chip on | accent hatch and 2px accent frame on each of my pieces that is attacked and undefended |
| answer arrow | solid when you found it, dashed when you missed |

## Components

| Component | Class | Notes |
|---|---|---|
| Bar | `.bar` | 56px, wordmark left (the favicon's knight in page ink + name, a link home; hover tips the hat), links, sound and theme right (no status chip: the scan's progress shows in the panel), 4px rule below |
| What it allowed | `.walk.why` | after the puzzle, one click ("What Nf6 allowed: Qxf7#"): my game move, their punishing reply and the engine's line, stepped like the idea, with what my move gave up |
| The idea | `.walk` | after the puzzle: every caption shows at once; the engine's move plays, then you step with Next move or by clicking a row (no autoplay) |
| Footer | `.foot` | full width under both columns, lined up with them, words from the left |
| Step previews | `.how .peek` | hover or focus on Fetch / Scan / Rewind shows a small looping picture of that step |
| Layout | `.main` | desktop: left and right columns share one top and one bottom, in the intro and in the drill |
| Site picker | `#site` + `.dropdown.compact` | small dropdown left of the username; the button shows only the site's mark (Simple Icons), the list shows mark + name |
| Status mark | `.mark` | 10px square: hollow idle, filled ready, blinking (steps, not fades) while working |
| Input | `.input` | 2px underline only; 4px on focus; italic serif placeholder |
| Dropdown | `.dropdown` (`src/select.js`) | custom: an underlined button like the inputs and a 2px-framed list; optgroups as mono headings; the active row gets `--tint`, the chosen one an accent square; full keyboard support; the hidden native `<select>` stays the source of truth |
| Time-control chip | `.toggle` | separate filter chips with a leading check box (the standard multi-select cue; joined boxes read as pick-one); hover = accent wash and outline; checked = filled accent tick and 2px border |
| Button | `.btn`, `.btn.primary`, `.btn.ghost` | 2px border, mono caps; hover inverts instantly |
| Progress | `.meter` | 4px track filling with `--accent` |
| Counters | `.counters` | inverted band; every column is a 2rem value row over a label row, so numbers and review bars share one line; box counts in tooltips |
| Question | `.question` | Playfair italic, one line ("Find the best move for White."), with a line of context under it ("You went wrong here in this game.") |
| Answer row | `.answer` | an accent square + "Move your piece on the board"; **Hint** (marks the piece to move, counts as a miss); after a wrong try a note says why (what it costs, or "that's what you played") and **Show me** appears |
| Note | `.note` | try-again message: accent wash with a 4px accent edge |
| Feedback | `.fb.ok`, `.fb.no` | verdict and game link; move cards (your move, the best move, what you played in the game, struck); eval bar or "Mate in N"; other accepted moves. Inverted only if the first try was right |
| Game link | `.game-link` | the underline never grows; the ↗ arrow nudges up-right on hover |
| Move card | `.card`, `.card.key`, `.card.struck` | the answer in accent; the game move struck through |
| Eval bar | `.evalbar` | −6 to +6 pawns, zero tick, hollow square before your move, filled after, accent span between |
| How it works | `.how` | three columns: accent number, one word, one mono line that never wraps |

## Texture

Two global layers at very low opacity so white reads as paper: horizontal print lines (4px period,
1.5%) and fractal noise (2%). The inverted band has its own vertical lines (3%).

## Motion

Instant. Button and toggle inversions take 100ms at most; the status mark blinks with `steps(1)`;
nothing eases, floats or bounces. `prefers-reduced-motion: reduce` turns all of it off.

Two exceptions, because they carry information on the board: a move slides (260ms) and a captured piece
fades, so the player sees what moved and what it took; and a right answer pops a check over the board
(1s, then gone). Right answers also get a rising two-note tone and wrong ones a low thud (Web Audio, mutable
in the bar). Verdict colors: right = accent with a check, wrong = black with a cross (`--ok-*`, `--no-*`).

## Accessibility

- Black on white is 21:1; secondary gray is 7.8:1; white on the band is 21:1, its labels about 15:1.
- Focus: 3px black outline with 3px offset on buttons and links; inputs thicken their underline to 4px.
- A skip link ("Skip to the controls") appears on focus.
- States are words first: "Found it." / "Not the one.", "Standby" / "Scanning" / "Ready" / "Fault".
- Toggles are real checkboxes; touch targets are at least 44px.

## Departures from the source design system

| Source | Here | Why |
|---|---|---|
| React, Tailwind, lucide-react | CSS custom properties, one inline lucide icon | no framework or build step in this app |
| `py-24`+ section padding, 8xl–9xl type everywhere | tight panel spacing, oversized type only in the hero | the brief is one screen with every main feature visible |
| Pricing tiers, testimonials, blog images, drop cap | not used | this is an app, not a marketing page; the bold choices that apply are kept (oversized hero, rule with square, inverted band, 4px rules, zero radius, instant inversions, textures) |

## Scout (scout/index.html)

Same frame, tokens and components as the drill; extra styles in `styles/scout.css`.

| Part | Class | Notes |
|---|---|---|
| Openings quest | `.openings-page`, `.quest` | openings/index.html, on Scout's layout: an opening select (every opening, then those White and Black choose, most played first) and a side; then counters (lines done, traps beaten, first try, streak), the opening's name, the moves so far as chips (yours in accent, a miss struck), the prompt, what they just played ("the 3rd most played (6%)"; a trap is only named after you answer), notes, **Show me**, **Next line** |
| Game plan | `.road`, `.plan-walk` | first tab. A list of plans (costly habit, its road, "Costs N", odds), then one plan: the road as chips (your moves in accent, theirs with how often), where they can go another way, then "Why it's punishable, move by move" as `.walk-steps` rows: why their move fails, then Stockfish's line (up to 12 plies, until neither side threatens anything) with a reason per move: what it takes, the threat it answers or makes, and material as it stands. The board shows the next move as an arrow; ← → (Home / End) and the ← / Next move buttons step through road, habit and line |
| Tools nav | `.tools` | in the bar beside the wordmark: Rewind, Openings, Scout; the current page underlined in ink. Under 420px the wordmark shows only the knight |
| You'll have | `.seg` | White / Black as two joined buttons (pick one) |
| Summary | `.scout-counters` | the inverted band: games, how often they win, how predictable, where they leave book |
| Tabs | `.tabs` | Weak spots, Explorer, Habits; one pane at a time, scrolling inside the panel on desktop |
| Rows | `.row` | a line or move, its opening name, a number, and their win / draw / loss as a 4px bar along the bottom (ink / accent-mid / hairline) |
| Explorer | `.crumbs`, `.opening` | the line so far as clickable moves; arrows on the board for the next moves, heavier = more often; their moves in ink, yours in accent |
| Habit check | `.slip-note`, `.tag.slip` | accent left rule on the tint; "Costs 1.2" tag in the habits list |
