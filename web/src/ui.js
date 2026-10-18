// Shared by the pages: the night-mode button and the engine workers.

/** One button flips paper and ink. The choice is saved; with none saved the system setting applies. */
export function setupTheme() {
  const btn = document.getElementById("btn-theme");
  const paint = () => {
    const dark = document.documentElement.dataset.theme === "dark";
    btn.setAttribute("aria-pressed", String(dark));
    btn.title = dark ? "Switch to day mode" : "Switch to night mode";
    btn.setAttribute("aria-label", btn.title);
    document.querySelector('meta[name="theme-color"]').content = dark ? "#0e0e10" : "#ffffff";
  };
  btn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("theme", next); } catch {}
    paint();
  });
  paint();
}

export function workerTransport(url) {
  const w = new Worker(url);
  let cb = () => {};
  w.onmessage = (e) => { for (const line of String(e.data).split("\n")) if (line) cb(line.trim()); };
  return { send: (l) => w.postMessage(l), onLine: (f) => (cb = f), terminate: () => w.terminate() };
}

/** One single-threaded engine per core, keeping one core for the page. Measured faster than threads at fixed depth. */
export function poolSize() {
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(cores - 1, 8));
}

/**
 * Fit each hero line to a share of the stage width (data-fit, default all of it), then shrink all of them together if the block is taller than
 * the room between the label and the rule. Runs on load, when fonts arrive and on resize.
 */
export function fitHero() {
  const h1 = document.getElementById("hero-title"), hero = h1?.closest(".hero");
  if (!h1 || !hero.offsetParent) return;
  const lines = [...h1.querySelectorAll(".fit")];
  const width = h1.clientWidth;
  for (const line of lines) {
    line.style.fontSize = "100px";
    line.style.fontSize = `${(100 * width * Number(line.dataset.fit || 1)) / line.scrollWidth}px`;
  }
  const others = [...hero.children].reduce((sum, el) => sum + (el.contains(h1) ? 0 : el.offsetHeight), 0);
  const label = h1.previousElementSibling?.offsetHeight || 0;
  const room = hero.clientHeight - others - label - 24;
  if (h1.offsetHeight > room && room > 0) {
    const k = room / h1.offsetHeight;
    for (const line of lines) line.style.fontSize = `${parseFloat(line.style.fontSize) * k}px`;
  }
}
