// Picking pieces up. Pressing on one of your pieces lifts it: it grows a little, casts a shadow and tilts as you
// move it, centred on the pointer (a little above a finger, so the finger doesn't hide it) until you drop it on a
// square. Tapping still works (tap the piece, tap where it goes): a press and release on the same square is a tap,
// and the piece pops up and settles back so the tap is felt. Keyboard clicks (Enter / Space) are left alone.
//
// The boards redraw their squares on every change, so this listens on the board element itself and asks the page
// what it may lift; it only ever calls the page's own tap(square), the same as a click.

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const DRAG_PX = 4;        // movement before a press counts as a drag rather than a tap
const SETTLE_MS = 140;    // the lifted piece gliding onto its square (or back home) when dropped
const TOUCH_RISE = 0.35;  // on touch, the piece rides this many squares above the finger

/**
 * board: the .board element. canLift(square): may the player pick up what's there now?
 * tap(square): the page's click handler. selected(): the square currently selected, or null.
 */
export function liftPieces(board, { canLift, tap, selected }) {
  board.classList.add("can-lift");
  let press = null;   // {sq, x, y, wasSel, lifted: {el, size}, moved, over, tilt, lastX, raf, rise}

  const squareAt = (x, y) => document.elementFromPoint(x, y)?.closest?.(".sq");
  const sqEl = (s) => board.querySelector(`[data-sq="${s}"]`);

  function place(x, y) {
    // Position in `translate`, not `transform`: the lift's `scale` would multiply a transform's offset as well.
    const { el, size } = press.lifted;
    el.style.translate = `${x - size / 2}px ${y - size / 2 - press.rise * size}px`;
    el.style.rotate = `${press.tilt.toFixed(1)}deg`;
  }

  function lift(sqNode, x, y) {
    const pc = sqNode.querySelector(".pc");
    if (!pc) return null;
    const size = sqNode.getBoundingClientRect().width;
    const el = document.createElement("span");
    el.className = `${pc.className} lifted`;
    el.setAttribute("aria-hidden", "true");
    Object.assign(el.style, { width: `${size}px`, height: `${size}px` });
    document.body.appendChild(el);
    board.dataset.lifting = sqNode.dataset.sq;
    return { el, size };
  }

  function hover(sqNode) {
    if (press.over === sqNode) return;
    press.over?.classList.remove("drop-over");
    press.over = sqNode && sqNode.dataset.sq !== press.sq ? sqNode : null;
    press.over?.classList.add("drop-over");
  }

  // The tilt eases back to upright between moves, so a quick swing leans the piece and a pause straightens it.
  function settleTilt() {
    if (!press?.lifted) return;
    press.tilt *= 0.82;
    place(press.lastX, press.lastY);
    press.raf = Math.abs(press.tilt) > 0.2 ? requestAnimationFrame(settleTilt) : null;
  }

  function finish(dropSq) {
    const p = press;
    press = null;
    p.over?.classList.remove("drop-over");
    delete board.dataset.lifting;
    cancelAnimationFrame(p.raf);
    if (!p.lifted) return;
    const { el, size } = p.lifted;
    // Glide onto the square it lands on (or back home), then let the redrawn board take over.
    const home = sqEl(dropSq || p.sq)?.getBoundingClientRect();
    if (home && !reducedMotion()) {
      el.classList.add("settling");
      el.style.translate = `${home.left + (home.width - size) / 2}px ${home.top + (home.height - size) / 2}px`;
      el.style.rotate = "0deg";
      setTimeout(() => el.remove(), SETTLE_MS);
    } else el.remove();
  }

  board.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || press) return;
    const node = e.target.closest?.(".sq");
    if (!node || !board.contains(node)) return;
    e.preventDefault();   // no text selection or native image drag while holding a piece
    const sq = node.dataset.sq;
    press = { sq, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, wasSel: selected() === sq, lifted: null, moved: false, over: null, tilt: 0, raf: null,
      rise: e.pointerType === "touch" ? TOUCH_RISE : 0 };
    board.setPointerCapture?.(e.pointerId);
    if (!canLift(sq)) return;
    if (!press.wasSel) tap(sq);   // select it: the board redraws with its targets marked
    const fresh = sqEl(sq);
    if (fresh) {
      press.lifted = lift(fresh, e.clientX, e.clientY);
      if (press.lifted) place(e.clientX, e.clientY);
    }
  });

  board.addEventListener("pointermove", (e) => {
    if (!press) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > DRAG_PX) press.moved = true;
    if (!press.lifted) return;
    if (!reducedMotion()) press.tilt = Math.max(-14, Math.min(14, press.tilt * 0.6 + (e.clientX - press.lastX) * 0.9));
    press.lastX = e.clientX;
    press.lastY = e.clientY;
    place(e.clientX, e.clientY);
    hover(squareAt(e.clientX, e.clientY));
    if (!press.raf && !reducedMotion()) press.raf = requestAnimationFrame(settleTilt);
  });

  board.addEventListener("pointerup", (e) => {
    if (!press) return;
    const target = squareAt(e.clientX, e.clientY)?.dataset.sq || null;
    const { sq, lifted, moved, wasSel } = press;
    if (lifted) {
      if (target && target !== sq) {
        finish(target);
        tap(target);            // the move (or, on an illegal square, whatever a tap there does)
      } else {
        finish(sq);
        if (wasSel && !moved) tap(sq);   // pressing the selected piece again puts it down, like a second click
      }
    } else {
      finish(null);
      if (target && (target === sq || moved)) tap(target);
    }
  });

  board.addEventListener("pointercancel", () => { if (press) finish(press.sq); });

  // Pointer presses are handled above; a click event after them would tap twice. Keyboard clicks have detail 0.
  board.addEventListener("click", (e) => { if (e.detail > 0) { e.stopPropagation(); e.preventDefault(); } }, true);
}
