/* Database page: shows the rows of each table, reading the project database in the browser with sql.js.
   The file is fetched the first time a reader asks for rows; after that every table opens at once.
   Each row takes one line and opens in full when clicked; codes are shown with their names; the rows that
   match can be downloaded as CSV. Plain titles, filters, column notes and the name lookups come from the
   JSON that the build puts in the page (#db-config). */
(() => {
  "use strict";

  const me = document.currentScript;
  const DB_URL = me.dataset.db;
  const DB_BYTES = Number(me.dataset.dbBytes) || 0;
  const SQLJS = me.dataset.sqljs;
  const CONFIG = JSON.parse(document.getElementById("db-config").textContent);
  const PAGE_SIZE = 25;
  const CELL = 300;       // characters put in a one-line cell; the rest is in the row's details
  const FOLD = 20000;     // characters of a value shown in the details before "Show all"

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';
  const count = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
  const OPEN_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" ' +
    'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // ------------------------------------------------------------------ the database file

  let dbPromise = null;
  const listeners = new Set();   // told how much of the file has arrived

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }

  async function fetchDb() {
    const r = await fetch(DB_URL);
    if (!r.ok) throw new Error("HTTP " + r.status);
    if (!r.body || !DB_BYTES) return new Uint8Array(await r.arrayBuffer());
    const reader = r.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      listeners.forEach((f) => f(got));
    }
    const buf = new Uint8Array(got);
    let at = 0;
    for (const c of chunks) {
      buf.set(c, at);
      at += c.length;
    }
    return buf;
  }

  function openDb() {
    if (!dbPromise) {
      dbPromise = Promise.all([
        (window.initSqlJs ? Promise.resolve() : loadScript(SQLJS + "sql-wasm.js"))
          .then(() => window.initSqlJs({ locateFile: (f) => SQLJS + f })),
        fetchDb(),
      ]).then(([SQL, buf]) => new SQL.Database(buf));
      dbPromise.catch(() => { dbPromise = null; });
    }
    return dbPromise;
  }

  function query(db, sql, params) {
    const st = db.prepare(sql);
    try {
      if (params) st.bind(params);
      const cols = st.getColumnNames();
      const rows = [];
      while (st.step()) rows.push(st.get());
      return { cols, rows };
    } finally {
      st.free();
    }
  }

  // Names shown next to codes: one lookup per query, shared by every table.
  const nameCache = new Map();
  function namesFor(db, col) {
    const sql = CONFIG.names[col];
    if (!nameCache.has(sql)) {
      nameCache.set(sql, new Map(query(db, sql).rows.map(([code, name]) => [String(code), { code, name: String(name) }])));
    }
    return nameCache.get(sql);
  }

  function number(v) {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(4)));
  }

  // ------------------------------------------------------------------ one row, in full

  let dialog = null;

  function getDialog() {
    if (dialog) return dialog;
    dialog = document.createElement("dialog");
    dialog.className = "db-dialog";
    dialog.setAttribute("aria-labelledby", "db-dialog-title");
    dialog.innerHTML =
      `<div class="db-dialog-head"><h2 id="db-dialog-title"></h2>` +
      `<div class="db-dialog-nav"><button type="button" class="button secondary" data-step="-1">Previous</button>` +
      `<button type="button" class="button secondary" data-step="1">Next</button>` +
      `<button type="button" class="db-close" aria-label="Close">×</button></div></div>` +
      `<dl class="db-fields"></dl>`;
    document.body.appendChild(dialog);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog || e.target.closest(".db-close")) {
        dialog.close();
        return;
      }
      const step = e.target.closest("button[data-step]");
      if (step) {
        dialog.browser.showRow(dialog.k + Number(step.dataset.step));
        return;
      }
      const more = e.target.closest("button.db-more");
      if (more) {
        const j = Number(more.dataset.j);
        more.parentElement.innerHTML = dialog.browser.fullValue(dialog.values[j], dialog.browser.cols[j], true);
      }
    });
    dialog.addEventListener("keydown", (e) => {
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        dialog.browser.showRow(dialog.k + (e.key === "ArrowLeft" ? -1 : 1));
      }
    });
    dialog.addEventListener("close", () => dialog.browser.rowClosed(dialog.k));
    return dialog;
  }

  // ------------------------------------------------------------------ the rows of one table

  class Browser {
    constructor(host, preset) {
      this.host = host;
      this.table = host.dataset.table;
      this.conf = CONFIG.tables[this.table] || { title: this.table, filters: [], notes: {}, named: [] };
      this.search = "";
      this.filters = {};     // column -> index into this.values[column], or "null"
      this.values = {};
      this.names = {};       // column -> Map of code -> {code, name}
      this.order = null;
      this.desc = false;
      this.offset = 0;
      this.rows = [];
      this.total = 0;
      this.ready = false;
      this.preset = preset || null;
      host.browser = this;
    }

    note(text) {
      let p = this.host.querySelector(".db-status");
      if (!p) {
        p = document.createElement("p");
        p.className = "db-status";
        this.host.appendChild(p);
      }
      p.textContent = text;
    }

    async start(button) {
      button.disabled = true;
      button.textContent = "Loading the database…";
      const total = (DB_BYTES / 1e6).toFixed(1);
      const show = (got) => { button.textContent = `Loading the database… ${(got / 1e6).toFixed(1)} of ${total} MB`; };
      listeners.add(show);
      try {
        this.db = await openDb();
      } catch (e) {
        button.disabled = false;
        button.textContent = "Show rows";
        this.host.browser = null;
        this.note("The database could not be loaded (" + e.message + "). Try again, or download the file.");
        return;
      } finally {
        listeners.delete(show);
      }
      try {
        this.cols = query(this.db, `select * from ${ident(this.table)} limit 0`).cols;
      } catch (e) {
        button.remove();
        this.host.browser = null;
        this.note("The copy of SQLite in this page cannot read this table (" + e.message + "). " +
          "Download the file to use it with any SQLite tool.");
        return;
      }
      for (const c of this.conf.named) this.names[c] = namesFor(this.db, c);
      for (const c of this.conf.filters) {
        this.values[c] = query(this.db, `select distinct ${ident(c)} from ${ident(this.table)} order by 1`).rows.map((r) => r[0]);
      }
      button.remove();
      this.build();
      this.ready = true;
      if (this.preset) this.apply(this.preset);
      else this.run();
    }

    nameOf(v, c) {
      const m = this.names[c];
      const e = m && v !== null ? m.get(String(v)) : null;
      return e ? e.name : "";
    }

    label(v, c) {
      const shown = v === null ? "(empty)" : typeof v === "number" ? number(v) : String(v);
      const name = this.nameOf(v, c);
      return name ? `${shown} · ${name}` : shown;
    }

    build() {
      const filters = this.conf.filters.map((c) => {
        const opts = this.values[c].map((v, i) => `<option value="${v === null ? "null" : i}">${esc(this.label(v, c))}</option>`).join("");
        return `<label class="db-filter"><span>${esc(c)}</span><select data-col="${esc(c)}"><option value="">all</option>${opts}</select></label>`;
      }).join("");
      const notes = this.conf.notes;
      this.host.innerHTML =
        `<div class="db-toolbar">` +
        `<label class="db-search"><span class="sr-only">Search ${esc(this.table)}</span>` +
        `<input type="search" placeholder="Search all columns" autocomplete="off"></label>${filters}` +
        `<button class="db-clear" type="button" hidden>Clear search and filters</button></div>` +
        `<div class="db-bar"><p class="db-status" aria-live="polite"></p>` +
        `<div class="db-actions"><button class="button secondary db-csv" type="button" ` +
        `title="All the rows that match, as a UTF-8 CSV file with a byte-order mark (for Excel)">Download CSV</button>` +
        `<button class="button secondary db-hide" type="button">Hide rows</button></div></div>` +
        `<div class="table-wrap"><table class="hb db-rows"><thead><tr>` +
        `<th scope="col" class="db-open-cell"><span class="sr-only">Open</span></th>` +
        this.cols.map((c) => {
          const title = notes[c] ? ` title="${esc(notes[c])}"` : "";
          return `<th scope="col"><button type="button" class="db-sort${notes[c] ? " has-note" : ""}" data-col="${esc(c)}"${title}>${esc(c)}</button></th>`;
        }).join("") +
        `</tr></thead><tbody></tbody></table></div>` +
        `<div class="db-pager"><button class="button secondary" type="button" data-step="-1">Previous</button>` +
        `<button class="button secondary" type="button" data-step="1">Next</button></div>`;

      let timer = 0;
      this.host.querySelector("input[type=search]").addEventListener("input", (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => { this.search = e.target.value.trim(); this.offset = 0; this.run(); }, 200);
      });
      this.host.querySelectorAll("select[data-col]").forEach((s) => s.addEventListener("change", () => {
        if (s.value === "") delete this.filters[s.dataset.col];
        else this.filters[s.dataset.col] = s.value;
        this.offset = 0;
        this.run();
      }));
      this.host.querySelector(".db-clear").addEventListener("click", () => this.apply({ order: this.order, desc: this.desc }));
      this.host.querySelectorAll(".db-sort").forEach((b) => b.addEventListener("click", () => {
        const c = b.dataset.col;
        if (this.order === c) this.desc = !this.desc;
        else { this.order = c; this.desc = false; }
        this.offset = 0;
        this.run();
      }));
      this.host.querySelectorAll(".db-pager button").forEach((b) => b.addEventListener("click", () => {
        this.offset = Math.max(0, this.offset + Number(b.dataset.step) * PAGE_SIZE);
        this.run();
      }));
      this.host.querySelector(".db-csv").addEventListener("click", () => this.csv());
      this.host.querySelector(".db-hide").addEventListener("click", () => {
        this.host.browser = null;
        this.host.innerHTML = `<button class="button secondary db-show" type="button">Show rows</button>`;
      });
      this.host.querySelector("tbody").addEventListener("click", (e) => {
        if (e.target.closest("a")) return;                        // a link in a cell opens as a link
        if (!e.target.closest("button") && String(window.getSelection())) return;   // selecting text
        const tr = e.target.closest("tr[data-k]");
        if (tr) this.showRow(Number(tr.dataset.k));
      });
    }

    // Filters and sort from a Start-here question, or none (Clear).
    apply(preset) {
      if (!this.ready) {
        this.preset = preset;
        return;
      }
      this.search = "";
      this.filters = {};
      for (const [c, v] of Object.entries(preset.filters || {})) {
        const i = (this.values[c] || []).indexOf(v);
        if (i >= 0) this.filters[c] = String(i);
      }
      this.order = preset.order || null;
      this.desc = !!preset.desc;
      this.offset = 0;
      this.host.querySelector("input[type=search]").value = "";
      this.host.querySelectorAll("select[data-col]").forEach((s) => { s.value = this.filters[s.dataset.col] ?? ""; });
      this.run();
    }

    where() {
      const where = [];
      const params = {};
      let i = 0;
      for (const [c, v] of Object.entries(this.filters)) {
        if (v === "null") where.push(`${ident(c)} is null`);
        else {
          where.push(`${ident(c)} = $f${i}`);
          params["$f" + i++] = this.values[c][Number(v)];
        }
      }
      if (this.search) {
        const any = this.cols.map((c) => `cast(${ident(c)} as text) like $q escape '\\'`);
        params.$q = "%" + this.search.replace(/[\\%_]/g, "\\$&") + "%";
        // A code also matches when its name does ("Germany" finds DE).
        const q = this.search.toLowerCase();
        for (const c of this.conf.named) {
          const hits = [...this.names[c].values()].filter((e) => e.name.toLowerCase().includes(q));
          if (hits.length) any.push(`${ident(c)} in (${hits.map((e) => { params["$n" + i] = e.code; return "$n" + i++; }).join(", ")})`);
        }
        where.push("(" + any.join(" or ") + ")");
      }
      return { sql: where.length ? " where " + where.join(" and ") : "", params };
    }

    orderBy() {
      // Every column after the sort column, so that ties keep one order from page to page.
      if (!this.order) return "";
      return ` order by ${ident(this.order)} ${this.desc ? "desc" : "asc"}, ` + this.cols.map((_, j) => j + 1).join(", ");
    }

    cell(v, c) {
      let inner;
      if (v === null) inner = `<span class="nil">—</span>`;
      else if (typeof v === "number") {
        const shown = number(v);
        inner = shown === String(v) ? shown : `<span title="${esc(v)}">${shown}</span>`;
      } else if (v instanceof Uint8Array) inner = `<span class="nil">binary, ${v.length} bytes</span>`;
      else if (/^https?:\/\/\S+$/.test(v)) inner = `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
      else inner = esc(v.length > CELL ? v.slice(0, CELL) + "…" : v);
      const name = this.nameOf(v, c);
      if (name) inner += `<span class="db-named"> · ${esc(name)}</span>`;
      return `<div class="db-c">${inner}</div>`;
    }

    fullValue(v, c, unfold) {
      if (v === null) return `<span class="nil">—</span>`;
      if (v instanceof Uint8Array) return `<span class="nil">binary, ${v.length} bytes</span>`;
      const name = this.nameOf(v, c);
      const named = name ? `<span class="db-named"> · ${esc(name)}</span>` : "";
      if (typeof v === "number") {
        const shown = number(v);
        return (shown === String(v) ? shown : `${shown} <span class="nil">(${esc(v)})</span>`) + named;
      }
      if (/^https?:\/\/\S+$/.test(v)) return `<a href="${esc(v)}" target="_blank" rel="noopener">${esc(v)}</a>`;
      if (v.length > FOLD && !unfold) {
        const j = this.cols.indexOf(c);
        return `${esc(v.slice(0, FOLD))}… <button type="button" class="db-more" data-j="${j}">Show all (${v.length.toLocaleString()} characters)</button>`;
      }
      return esc(v) + named;
    }

    run() {
      const { sql, params } = this.where();
      const from = `from ${ident(this.table)}${sql}`;
      const total = query(this.db, `select count(*) ${from}`, params).rows[0][0];
      if (this.offset >= total) this.offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      const { rows } = query(this.db, `select * ${from}${this.orderBy()} limit ${PAGE_SIZE} offset ${this.offset}`, params);
      this.rows = rows;
      this.total = total;

      this.host.querySelector("tbody").innerHTML = rows.map((r, i) => {
        const k = this.offset + i;
        return `<tr data-k="${k}"><td class="db-open-cell"><button type="button" class="db-open" ` +
          `aria-label="Open row ${(k + 1).toLocaleString()}">${OPEN_ICON}</button></td>` +
          r.map((v, j) => `<td>${this.cell(v, this.cols[j])}</td>`).join("") + "</tr>";
      }).join("");
      this.host.querySelectorAll(".db-sort").forEach((b) => {
        b.parentElement.setAttribute("aria-sort", b.dataset.col === this.order ? (this.desc ? "descending" : "ascending") : "none");
      });
      this.host.querySelector(".db-status").textContent = total
        ? `Rows ${(this.offset + 1).toLocaleString()}–${(this.offset + rows.length).toLocaleString()} of ` +
          `${total.toLocaleString()}. Click a row to see all of its fields.`
        : "No rows match.";
      const csv = this.host.querySelector(".db-csv");
      csv.textContent = `Download CSV (${count(total, "row")})`;
      csv.disabled = total === 0;
      this.host.querySelector(".db-clear").hidden = !this.search && !Object.keys(this.filters).length;
      const [prev, next] = this.host.querySelectorAll(".db-pager button");
      prev.disabled = this.offset === 0;
      next.disabled = this.offset + PAGE_SIZE >= total;
      this.host.querySelector(".db-pager").hidden = total <= PAGE_SIZE;
    }

    // Row k of the rows that match, in the order shown; the table turns to its page.
    showRow(k) {
      if (k < 0 || k >= this.total) return;
      if (k < this.offset || k >= this.offset + this.rows.length) {
        this.offset = Math.floor(k / PAGE_SIZE) * PAGE_SIZE;
        this.run();
      }
      const row = this.rows[k - this.offset];
      const d = getDialog();
      d.browser = this;
      d.k = k;
      d.values = row;
      d.querySelector("h2").innerHTML = `${esc(this.conf.title)} <code>${esc(this.table)}</code>` +
        `<span>Row ${(k + 1).toLocaleString()} of ${this.total.toLocaleString()}</span>`;
      d.querySelector(".db-fields").innerHTML = this.cols.map((c, j) => {
        const note = this.conf.notes[c];
        return `<div><dt><code>${esc(c)}</code>${note ? `<span>${esc(note)}</span>` : ""}</dt>` +
          `<dd>${this.fullValue(row[j], c, false)}</dd></div>`;
      }).join("");
      const [prev, next] = d.querySelectorAll("button[data-step]");
      prev.disabled = k === 0;
      next.disabled = k >= this.total - 1;
      this.host.querySelectorAll("tr.is-current").forEach((tr) => tr.classList.remove("is-current"));
      const tr = this.host.querySelector(`tr[data-k="${k}"]`);
      if (tr) tr.classList.add("is-current");
      if (!d.open) d.showModal();
      if (document.activeElement && document.activeElement.disabled) d.querySelector(".db-close").focus();
      d.scrollTop = 0;
    }

    rowClosed(k) {
      const b = this.host.querySelector(`tr[data-k="${k}"] .db-open`);
      if (b) b.focus();
    }

    // All the rows that match, in the order shown, as CSV (UTF-8 with a byte-order mark, which Excel needs
    // to read non-English text).
    csv() {
      const { sql, params } = this.where();
      const { cols, rows } = query(this.db, `select * from ${ident(this.table)}${sql}${this.orderBy()}`, params);
      const field = (v) => {
        if (v === null || v instanceof Uint8Array) return "";
        const s = String(v);
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const text = "﻿" + [cols, ...rows].map((r) => r.map(field).join(",")).join("\r\n") + "\r\n";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
      a.download = `${this.table}${sql ? "_filtered" : ""}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
  }

  // ------------------------------------------------------------------ Show rows, and the Start-here questions

  document.addEventListener("click", (e) => {
    const q = e.target.closest("a.db-q");
    if (q) {
      // The link itself scrolls to the table (appendix.js); this opens the rows with the question's filters.
      const host = document.querySelector(`.db-browse[data-table="${q.dataset.table}"]`);
      if (!host) return;
      const preset = { filters: JSON.parse(q.dataset.filters || "{}"), order: q.dataset.order || null, desc: q.dataset.desc === "1" };
      if (host.browser) host.browser.apply(preset);
      else {
        const b = host.querySelector("button.db-show");
        if (b) new Browser(host, preset).start(b);
      }
      return;
    }
    const b = e.target.closest("button.db-show");
    if (b && !b.closest(".db-browse").browser) new Browser(b.closest(".db-browse")).start(b);
  });
})();
