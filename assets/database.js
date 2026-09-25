/* Database page: shows the rows of each table, reading the project database in the browser with sql.js.
   The file is fetched the first time a reader asks for rows; after that every table opens at once. */
(() => {
  "use strict";

  const me = document.currentScript;
  const DB_URL = me.dataset.db;
  const SQLJS = me.dataset.sqljs;
  const PAGE_SIZE = 25;
  const CLIP = 180;        // characters shown before a long value is folded
  const MAX_FILTERS = 5;   // drop-down filters per table, for columns with 2 to 12 distinct values

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const ident = (s) => '"' + String(s).replace(/"/g, '""') + '"';

  let dbPromise = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }

  function openDb() {
    if (!dbPromise) {
      dbPromise = Promise.all([
        (window.initSqlJs ? Promise.resolve() : loadScript(SQLJS + "sql-wasm.js"))
          .then(() => window.initSqlJs({ locateFile: (f) => SQLJS + f })),
        fetch(DB_URL).then((r) => {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.arrayBuffer();
        }),
      ]).then(([SQL, buf]) => new SQL.Database(new Uint8Array(buf)));
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

  function number(v) {
    if (Number.isInteger(v)) return String(v);
    return String(Number(v.toFixed(4)));
  }

  class Browser {
    constructor(host) {
      this.host = host;
      this.table = host.dataset.table;
      this.search = "";
      this.filters = {};     // column -> index into this.values[column], or "null"
      this.values = {};
      this.order = null;
      this.desc = false;
      this.offset = 0;
      this.long = [];
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
      try {
        this.db = await openDb();
      } catch (e) {
        button.disabled = false;
        button.textContent = "Show rows";
        this.note("The database could not be loaded (" + e.message + "). Try again, or download the file.");
        return;
      }
      try {
        this.cols = query(this.db, `select * from ${ident(this.table)} limit 0`).cols;
      } catch (e) {
        button.remove();
        this.note("The copy of SQLite in this page cannot read this table (" + e.message + "). " +
          "Download the file to use it with any SQLite tool.");
        return;
      }
      for (const c of this.cols) {
        if (Object.keys(this.values).length >= MAX_FILTERS) break;
        const n = query(this.db, `select count(distinct ${ident(c)}) + max(${ident(c)} is null) from ${ident(this.table)}`).rows[0][0];
        if (n >= 2 && n <= 12) {
          this.values[c] = query(this.db, `select distinct ${ident(c)} from ${ident(this.table)} order by 1`).rows.map((r) => r[0]);
        }
      }
      button.remove();
      this.build();
      this.run();
    }

    build() {
      const filters = Object.entries(this.values).map(([c, vals]) => {
        const opts = vals.map((v, i) => v === null
          ? `<option value="null">(empty)</option>`
          : `<option value="${i}">${esc(typeof v === "number" ? number(v) : v)}</option>`).join("");
        return `<label class="db-filter"><span>${esc(c)}</span><select data-col="${esc(c)}"><option value="">all</option>${opts}</select></label>`;
      }).join("");
      this.host.innerHTML =
        `<div class="db-toolbar">` +
        `<label class="db-search"><span class="sr-only">Search ${esc(this.table)}</span>` +
        `<input type="search" placeholder="Search all columns" autocomplete="off"></label>${filters}` +
        `<button class="button secondary db-hide" type="button">Hide rows</button></div>` +
        `<p class="db-status" aria-live="polite"></p>` +
        `<div class="table-wrap"><table class="hb db-rows"><thead><tr>` +
        this.cols.map((c) => `<th scope="col"><button type="button" class="db-sort" data-col="${esc(c)}">${esc(c)}</button></th>`).join("") +
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
      this.host.querySelector(".db-hide").addEventListener("click", () => {
        this.host.innerHTML = `<button class="button secondary db-show" type="button">Show rows</button>`;
      });
      this.host.querySelector("tbody").addEventListener("click", (e) => {
        const b = e.target.closest("button.db-more");
        if (!b) return;
        const td = b.closest("td");
        const full = this.long[Number(b.dataset.k)];
        if (b.dataset.open === "1") {
          td.innerHTML = this.clip(full, Number(b.dataset.k));
        } else {
          td.innerHTML = `<div class="db-long">${esc(full)}</div><button type="button" class="db-more" data-k="${b.dataset.k}" data-open="1">Show less</button>`;
        }
      });
    }

    clip(text, k) {
      return `${esc(text.slice(0, CLIP))}… <button type="button" class="db-more" data-k="${k}">Show all (${text.length.toLocaleString()} characters)</button>`;
    }

    cell(v) {
      if (v === null) return `<span class="nil">—</span>`;
      if (typeof v === "number") {
        const shown = number(v);
        return shown === String(v) ? shown : `<span title="${esc(v)}">${shown}</span>`;
      }
      if (v instanceof Uint8Array) return `<span class="nil">binary, ${v.length} bytes</span>`;
      const s = String(v);
      if (/^https?:\/\/\S+$/.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener">${esc(s)}</a>`;
      if (s.length > CLIP + 40) {
        this.long.push(s);
        return this.clip(s, this.long.length - 1);
      }
      return esc(s);
    }

    run() {
      const where = [];
      const params = {};
      Object.entries(this.filters).forEach(([c, v], i) => {
        if (v === "null") where.push(`${ident(c)} is null`);
        else {
          where.push(`${ident(c)} = $f${i}`);
          params["$f" + i] = this.values[c][Number(v)];
        }
      });
      if (this.search) {
        where.push("(" + this.cols.map((c) => `cast(${ident(c)} as text) like $q escape '\\'`).join(" or ") + ")");
        params.$q = "%" + this.search.replace(/[\\%_]/g, "\\$&") + "%";
      }
      const w = where.length ? " where " + where.join(" and ") : "";
      const from = `from ${ident(this.table)}${w}`;
      const total = query(this.db, `select count(*) ${from}`, params).rows[0][0];
      if (this.offset >= total) this.offset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE);
      const order = this.order ? ` order by ${ident(this.order)} ${this.desc ? "desc" : "asc"}` : "";
      const { rows } = query(this.db, `select * ${from}${order} limit ${PAGE_SIZE} offset ${this.offset}`, params);

      this.long = [];
      this.host.querySelector("tbody").innerHTML = rows.map((r) =>
        "<tr>" + r.map((v) => `<td>${this.cell(v)}</td>`).join("") + "</tr>").join("");
      this.host.querySelectorAll(".db-sort").forEach((b) => {
        b.parentElement.setAttribute("aria-sort", b.dataset.col === this.order ? (this.desc ? "descending" : "ascending") : "none");
      });
      const status = this.host.querySelector(".db-status");
      status.textContent = total
        ? `Rows ${(this.offset + 1).toLocaleString()}–${(this.offset + rows.length).toLocaleString()} of ${total.toLocaleString()}`
        : "No rows match.";
      const [prev, next] = this.host.querySelectorAll(".db-pager button");
      prev.disabled = this.offset === 0;
      next.disabled = this.offset + PAGE_SIZE >= total;
      this.host.querySelector(".db-pager").hidden = total <= PAGE_SIZE;
    }
  }

  document.addEventListener("click", (e) => {
    const b = e.target.closest("button.db-show");
    if (!b) return;
    const host = b.closest(".db-browse");
    new Browser(host).start(b);
  });
})();
