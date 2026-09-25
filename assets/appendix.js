/* Online appendix: the contents bar follows the reader's position; on narrow screens it opens as a drawer. */
(() => {
  "use strict";

  const toc = document.querySelector(".toc");
  const scroller = document.querySelector(".sidebar-scroll");
  const label = document.getElementById("current-label");
  const toggle = document.querySelector(".toc-toggle");
  const backdrop = document.querySelector(".backdrop");
  if (!toc) return;

  const narrow = window.matchMedia("(max-width: 1079px)");
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");

  // One entry per contents link, in page order.
  const entries = Array.from(toc.querySelectorAll('a[href^="#"]'))
    .map((a) => ({ a, li: a.parentElement, el: document.getElementById(decodeURIComponent(a.hash.slice(1))) }))
    .filter((e) => e.el);

  let active = null;
  let holdUntil = 0; // while a clicked link scrolls the page, keep its entry marked

  // Height of whatever stays fixed at the top: the contents bar on narrow screens, the row of page buttons otherwise.
  function topInset() {
    if (narrow.matches) return 52;
    return parseFloat(getComputedStyle(document.body).getPropertyValue("--bar-h")) || 0;
  }

  function readingLine() {
    return topInset() + Math.min(Math.max(window.innerHeight * 0.22, 80), 200);
  }

  function pick() {
    const doc = document.documentElement;
    if (window.scrollY + window.innerHeight >= doc.scrollHeight - 4) return entries[entries.length - 1];
    const line = readingLine();
    let found = entries[0];
    for (const e of entries) {
      if (e.el.getBoundingClientRect().top <= line) found = e;
      else break;
    }
    return found;
  }

  function partOf(e) {
    let li = e.li;
    let part = null;
    while (li && toc.contains(li)) {
      part = li;
      li = li.parentElement.closest("li");
    }
    const a = part && part.querySelector(":scope > a");
    return a && a !== e.a ? a.textContent : "";
  }

  function keepVisible(a) {
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const r = a.getBoundingClientRect();
    const margin = 56;
    if (r.top < box.top + margin || r.bottom > box.bottom - margin) {
      scroller.scrollTo({
        top: scroller.scrollTop + (r.top - box.top) - box.height / 3,
        behavior: reduced.matches ? "auto" : "smooth",
      });
    }
  }

  function setActive(e) {
    if (!e || e === active) return;
    active = e;
    toc.querySelectorAll("li.is-open").forEach((li) => li.classList.remove("is-open"));
    toc.querySelectorAll("a.is-trail").forEach((a) => a.classList.remove("is-trail"));
    toc.querySelectorAll("a[aria-current]").forEach((a) => a.removeAttribute("aria-current"));
    e.a.setAttribute("aria-current", "location");
    let li = e.li;
    while (li && toc.contains(li)) {
      li.classList.add("is-open");
      const a = li.querySelector(":scope > a");
      if (a && a !== e.a) a.classList.add("is-trail");
      li = li.parentElement.closest("li");
    }
    if (label) {
      const part = partOf(e);
      label.textContent = part ? `${part} · ${e.a.textContent}` : e.a.textContent;
    }
    keepVisible(e.a);
  }

  let queued = false;
  function update() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (performance.now() < holdUntil) return;
      setActive(pick());
    });
  }

  window.addEventListener("scroll", update, { passive: true });
  window.addEventListener("resize", update);
  window.addEventListener("load", update);
  window.addEventListener("scrollend", () => {
    holdUntil = 0;
    update();
  });
  window.addEventListener("hashchange", update);
  setActive(pick());

  // ---------------------------------------------------------------- drawer

  function openNav(open) {
    document.body.classList.toggle("nav-open", open);
    if (toggle) toggle.setAttribute("aria-expanded", String(open));
    if (backdrop) backdrop.hidden = !open;
    if (open && active) requestAnimationFrame(() => keepVisible(active.a));
  }

  if (toggle) toggle.addEventListener("click", () => openNav(!document.body.classList.contains("nav-open")));
  if (backdrop) backdrop.addEventListener("click", () => openNav(false));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && document.body.classList.contains("nav-open")) {
      openNav(false);
      if (toggle) toggle.focus();
    }
  });
  narrow.addEventListener("change", () => openNav(false));

  toc.addEventListener("click", (ev) => {
    const a = ev.target.closest('a[href^="#"]');
    if (!a) return;
    const e = entries.find((x) => x.a === a);
    if (e) {
      setActive(e);
      holdUntil = performance.now() + (reduced.matches ? 0 : 1200);
    }
    openNav(false);
  });

  // Links within the page scroll there smoothly. A link opened from elsewhere (…#sec-iv-b) jumps at once,
  // which is why smooth scrolling is not set for the whole page in the stylesheet.
  document.addEventListener("click", (ev) => {
    if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    const a = ev.target.closest('a[href^="#"]');
    if (!a || a.target) return;
    const el = document.getElementById(decodeURIComponent(a.hash.slice(1)));
    if (!el) return;
    ev.preventDefault();
    const smooth = !reduced.matches;
    const startY = window.scrollY;
    el.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "start" });
    // Where the browser does not animate the scroll (some embedded views), jump instead of staying put.
    if (smooth) setTimeout(() => { if (window.scrollY === startY) el.scrollIntoView({ block: "start" }); }, 700);
    if (location.hash !== a.hash) history.pushState(null, "", a.hash);
  });
})();
