// The Record History tab of the Tulbelt page (shell: toggles/tulbelt-page.js).
//
// Debugging a table record usually means reading its change history, and the
// only place Tulip shows that is the Record History widget — which lives in an
// app, so the habit is to build a throwaway admin app with a table picker, a
// record placeholder, and the widget. This tab is that app without the app,
// laid out the way those apps usually are: on the left a table and a search over that table's records; on the right the history of
// whichever record is picked.
//
// The data is the widget's own. It does not come from a REST endpoint; the
// widget calls the Meteor method `getHistoryRecord` on the page's DDP
// connection, and toggles/record-history-main.js makes that same call for us
// from the MAIN world (this world has no Meteor). What comes back is a list of
// event groups, which this file draws the way the widget does: who acted and
// through what (an app at a station, the admin interface, the API, an
// automation, an AI agent), then each create / update / delete / signature
// with its old and new values. docs/record-history.md has the shapes.
//
// Everything around the history call is the plain table API that Data Queries
// already uses, with the session's borrowed credential (tulbelt-session-main):
// the table list and the record search.
//
// Tulip's own table page gets a way in: a history icon among the buttons at
// its top right, which opens this tab with that table already picked.
//
// None of it is exposed on an instance that has no record history. Tulip only
// keeps the audit trail when the plan feature behind the widget is on, so the
// toggle being on is a wish, not a fact: the tab and the table-page button
// appear once the MAIN half has confirmed the feature, and not before.
//
// It works in the workspace the tab is in, and only there: `getHistoryRecord`
// takes no workspace argument — it runs in whichever one the tab's connection
// is in — so there is no workspace picker. To read another workspace's
// records, switch Tulip to it first.
//
(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "record-history";
  const STYLE_ID = "tulbelt-rh-styles";
  const CONTAINER_ID = "tulbelt-rh-page";
  const REQUEST_EVENT = "tulbelt:rh-request";
  const RESPONSE_EVENT = "tulbelt:rh-response";
  // A method call on a dropped connection queues forever; don't wait with it.
  const BRIDGE_TIMEOUT_MS = 60000;
  const SUGGEST_DEBOUNCE_MS = 200;
  const SEARCH_DEBOUNCE_MS = 250;
  // Records per page of the search list; the table API serves at most 100.
  const RECORDS_PAGE = 50;
  // Text columns the search looks in besides the id. Each is one more filter
  // in the query string, so a very wide table is searched on its first few.
  const SEARCH_COLUMNS_MAX = 12;

  // Survives switching tabs and coming back.
  const state = {
    tables: null, // [{ id, name, columns }] in the tab's workspace
    tablesError: "",
    tableText: "", // what the table field shows
    table: null, // the table the record list is for: { id, name, columns }
    search: "",
    // The record list. null until a table has been searched; `recordsMore`
    // says the last page came back full, so there may be another.
    records: null,
    recordsLoading: false,
    recordsError: "",
    recordsMore: false,
    loading: false,
    error: "",
    // The history on screen, and what it is the history *of* — the fields can
    // be edited afterwards without the heading changing under the result.
    history: null,
    shown: null, // { tableId, tableName, recordId }
    isLimited: false,
    minDate: null,
    cursor: "",
    sortDir: "asc",
    hideOldValues: false,
    hideProcessData: false,
    signedCompletionsOnly: false,
  };

  let root = null; // the mounted container, null while the tab is closed

  // ── Session (the same borrowed credential Data Queries uses) ────────────────

  const sessionAuth = () => document.documentElement.getAttribute("data-tulbelt-auth") || "";

  function ambientWorkspaceId() {
    const attr = document.documentElement.getAttribute("data-tulbelt-wsid");
    if (attr) return attr;
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const m = /\/api\/[^/]+\/v\d+\/w\/(\d+)\//.exec(entry.name);
        if (m) return m[1];
      }
    } catch (_) {}
    return "1";
  }

  async function apiJson(path) {
    const url = `${location.origin}${path}`;
    const base = { Accept: "application/json" };
    const auth = sessionAuth();
    const send = (headers) => fetch(url, { credentials: "include", headers });
    let resp = await send(auth ? { ...base, Authorization: auth } : base);
    // A sniffed header can be stale; cookies may carry the session on their own.
    if (auth && (resp.status === 401 || resp.status === 403)) resp = await send(base);
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const err = new Error(`API error ${resp.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      err.status = resp.status;
      throw err;
    }
    return resp.json();
  }

  // ── Bridge to the MAIN world ────────────────────────────────────────────────

  let nextRequest = 1;

  function bridge(op, payload = {}, timeoutMs = BRIDGE_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      const id = `rh${nextRequest++}`;
      const timer = setTimeout(() => {
        document.removeEventListener(RESPONSE_EVENT, onResponse);
        reject(
          new Error(
            "No answer from Tulip. Reload this tab so the extension's page script is in place, then try again.",
          ),
        );
      }, timeoutMs);
      function onResponse(e) {
        let msg;
        try {
          msg = JSON.parse(e.detail);
        } catch (_) {
          return;
        }
        if (msg?.id !== id) return;
        clearTimeout(timer);
        document.removeEventListener(RESPONSE_EVENT, onResponse);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(msg.error || "The history call failed."));
      }
      document.addEventListener(RESPONSE_EVENT, onResponse);
      document.dispatchEvent(
        new CustomEvent(REQUEST_EVENT, { detail: JSON.stringify({ id, op, ...payload }) }),
      );
    });
  }

  // ── Tables ──────────────────────────────────────────────────────────────────

  // Private endpoints whose shapes we have second-hand: read ids and names
  // defensively, and treat every spelling of "archived" as gone.
  const listOf = (payload, ...keys) => {
    if (Array.isArray(payload)) return payload;
    for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
    return [];
  };
  const isArchived = (item) =>
    Boolean(item.deleted || item.deletedAt || item.archived || item.isArchived || item.archivedAt);

  async function loadTables() {
    state.tables = null;
    state.tablesError = "";
    renderNotes();
    let tables = [];
    let error = "";
    try {
      tables = listOf(
        await apiJson(`/api/v3/w/${encodeURIComponent(ambientWorkspaceId())}/tables`),
        "tables",
        "items",
      )
        .filter((t) => t && !isArchived(t))
        .map((t) => ({
          id: t.id || t.tableId || t._id,
          name: t.label || t.name || "",
          columns: Array.isArray(t.columns) ? columnsOf(t) : null,
        }))
        .filter((t) => typeof t.id === "string" && t.id)
        .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    } catch (err) {
      error = `Couldn't list this workspace's tables (${err.message}). Paste a table id or URL instead.`;
    }
    state.tables = tables;
    state.tablesError = error;
    // A table carried over from the last visit picks up its current name and
    // columns; the record list it already has stands.
    const fresh = state.table && tables.find((t) => t.id === state.table.id);
    if (fresh) {
      // Arriving from a table page we had only the id to show; now the name.
      if (state.tableText === state.table.id && fresh.name) {
        state.tableText = fresh.name;
        if (tableInput) tableInput.value = fresh.name;
      }
      state.table = fresh;
      // Its columns are what the rows' summary lines are drawn from.
      renderRecords();
    }
    renderNotes();
  }

  // TableMetadata.columns is [{ name, label, dataType: { type } }]; read it
  // defensively, and leave archived columns out — nobody searches for those.
  function columnsOf(meta) {
    const cols = meta?.columns || meta?.fields || [];
    if (!Array.isArray(cols)) return [];
    return cols
      .filter((c) => c && !c.hidden && !isArchived(c))
      .map((c) => ({
        name: c.name || c.fieldId || c.id,
        label: c.label || c.displayName || c.name || "",
        type: String(c.dataType?.type || c.dataType || c.type || "").toLowerCase(),
      }))
      .filter((c) => typeof c.name === "string" && c.name);
  }

  // The list call brings every table's columns with it. A pasted id it didn't
  // cover costs one metadata call; failing that the search is by id alone.
  async function ensureColumns(table) {
    if (table.columns) return table.columns;
    try {
      table.columns = columnsOf(
        await apiJson(
          `/api/v3/w/${encodeURIComponent(ambientWorkspaceId())}/tables/${encodeURIComponent(table.id)}`,
        ),
      );
    } catch (_) {
      table.columns = [];
    }
    return table.columns;
  }

  const textColumns = (table) =>
    (table.columns || []).filter((c) => c.type === "string" && c.name !== "id");

  // A bare id, or anything containing one — a pasted table URL is the obvious
  // thing to reach for.
  function parseTableId(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const fromUrl = /\/table\/([A-Za-z0-9_-]+)/.exec(text);
    if (fromUrl) return fromUrl[1];
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
  }

  // The table field holds a name after a pick and an id or URL after a paste.
  function resolveTable(text = state.tableText) {
    const q = String(text || "").trim();
    if (!q) return null;
    const tables = state.tables || [];
    const byName = tables.find((t) => t.name && t.name.toLowerCase() === q.toLowerCase());
    if (byName) return byName;
    const id = parseTableId(q);
    if (!id) return null;
    return tables.find((t) => t.id === id) || { id, name: "" };
  }

  function tableOptions(query) {
    const q = query.trim().toLowerCase();
    const all = state.tables || [];
    // Text that already names one table would filter the list down to it.
    const exact = all.some((t) => t.name.toLowerCase() === q || t.id.toLowerCase() === q);
    const hits =
      !q || exact
        ? all
        : all.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
    return hits.map((t) => ({ value: t.name || t.id, label: t.name || t.id, tag: t.id }));
  }

  // ── Record search ───────────────────────────────────────────────────────────

  function recordsPath(table, filters, offset) {
    const search = new URLSearchParams({ limit: String(RECORDS_PAGE), offset: String(offset) });
    if (filters.length > 0) {
      search.append("filters", JSON.stringify(filters));
      search.append("filterAggregator", "any");
    }
    search.append("sortOptions", JSON.stringify([{ sortBy: "_updatedAt", sortDir: "desc" }]));
    return `/api/v3/w/${encodeURIComponent(ambientWorkspaceId())}/tables/${encodeURIComponent(table.id)}/records?${search}`;
  }

  // Records whose id — or any text column — contains what was typed, most
  // recently touched first; an empty box lists the table's latest records,
  // which is often where the one you want is. `append` fetches the next page
  // of the same search.
  let searchSeq = 0;

  async function searchRecords({ append = false } = {}) {
    const table = state.table;
    const mine = ++searchSeq;
    if (!table) {
      state.records = null;
      state.recordsLoading = false;
      state.recordsError = "";
      renderRecords();
      return;
    }
    const q = state.search.trim();
    const offset = append ? (state.records || []).length : 0;
    state.recordsLoading = true;
    state.recordsError = "";
    renderRecords();

    let rows = [];
    let error = "";
    try {
      const idFilter = { field: "id", functionType: "contains", arg: q };
      // Wanted even with nothing typed: the rows' summary lines use them.
      const known = await ensureColumns(table);
      const columns = q ? textColumns({ columns: known }) : [];
      const wide = columns
        .slice(0, SEARCH_COLUMNS_MAX)
        .map((c) => ({ field: c.name, functionType: "contains", arg: q }));
      try {
        rows = await apiJson(recordsPath(table, q ? [idFilter, ...wide] : [], offset));
      } catch (err) {
        // A column the API won't run `contains` on sinks the whole query;
        // the id alone is always searchable.
        if (err.status !== 400 || wide.length === 0) throw err;
        rows = await apiJson(recordsPath(table, [idFilter], offset));
      }
    } catch (err) {
      error =
        err.status === 404
          ? "No table with that id in this workspace."
          : `Couldn't search this table (${err.message}).`;
    }
    if (mine !== searchSeq) return; // a newer search has taken over
    const page = listOf(rows, "records", "items").filter((r) => r && r.id != null);
    state.records = append ? [...(state.records || []), ...page] : page;
    state.recordsMore = !error && page.length === RECORDS_PAGE;
    state.recordsError = error;
    state.recordsLoading = false;
    renderRecords();
  }

  let searchTimer = null;
  function scheduleSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchRecords, SEARCH_DEBOUNCE_MS);
  }

  // The table field was settled — picked, Entered, or left with new text.
  function commitTable() {
    const next = resolveTable();
    if ((next?.id || "") === (state.table?.id || "") && state.records) return;
    state.table = next;
    clearTimeout(searchTimer);
    searchRecords();
  }

  // ── History ─────────────────────────────────────────────────────────────────

  // The method pages backwards: each further slice is *older*, so it goes in
  // front. Where the seam falls inside one app run — same actor, station and
  // app — the two halves are one group, and likewise one step. This is the
  // widget's own stitching.
  function mergeHistory(older, newer) {
    if (older.length === 0 || newer.length === 0) return [...older, ...newer];
    const a = older[older.length - 1];
    const b = newer[0];
    const sameRun =
      a.context === "app" &&
      b.context === "app" &&
      JSON.stringify(a.actor) === JSON.stringify(b.actor) &&
      a.stationId === b.stationId &&
      a.processId === b.processId;
    if (!sameRun) return [...older, ...newer];
    const steps = mergeSteps(a.steps || [], b.steps || []);
    return [...older.slice(0, -1), { ...a, steps }, ...newer.slice(1)];
  }

  function mergeSteps(older, newer) {
    if (older.length === 0 || newer.length === 0) return [...older, ...newer];
    const a = older[older.length - 1];
    const b = newer[0];
    if (a.stepId !== b.stepId || a.statesProcessesId !== b.statesProcessesId) {
      return [...older, ...newer];
    }
    const joined = { ...a, events: [...(a.events || []), ...(b.events || [])] };
    return [...older.slice(0, -1), joined, ...newer.slice(1)];
  }

  // `more` continues the history on screen from its cursor; `again` re-asks
  // for it from the top (an option changed). Either way the target is what is
  // on screen, not whatever the fields have been edited to since.
  async function fetchHistory({ recordId = "", more = false, again = false, all = false } = {}) {
    let target;
    if (more || again) {
      target = state.shown;
      if (!target || state.loading) return;
    } else {
      const table = state.table;
      if (!table || !recordId) return;
      target = { tableId: table.id, tableName: table.name, recordId };
      // Show the pick straight away; the history follows.
      state.history = null;
      state.shown = target;
    }

    state.loading = true;
    state.error = "";
    renderResult();
    markSelected();
    try {
      const result = await bridge("history", {
        tableId: target.tableId,
        recordId: target.recordId,
        hideProcessData: state.hideProcessData,
        signedCompletionsOnly: state.signedCompletionsOnly,
        cursor: more ? state.cursor : "",
        all,
      });
      // Another record was picked while this one loaded; its answer is the
      // one that counts.
      if (state.shown !== target) return;
      state.history = more ? mergeHistory(result.historyRecord, state.history || []) : result.historyRecord;
      state.isLimited = result.isLimited;
      state.minDate = result.isLimited ? result.minDate : null;
      state.cursor = result.cursor || "";
    } catch (err) {
      if (state.shown !== target) return;
      state.error = err?.message || String(err);
      if (!more) state.history = null;
    }
    state.loading = false;
    renderResult();
  }

  // ── DOM helpers ─────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  const strong = (text) => el("strong", "", text == null ? "" : String(text));

  // "{user} ran {app}" with nodes dropped into the braces.
  function sentence(template, parts) {
    const span = el("span", "rh-sentence");
    for (const piece of template.split(/(\{\w+\})/)) {
      const key = /^\{(\w+)\}$/.exec(piece)?.[1];
      if (key && parts[key] != null) span.append(parts[key]);
      else if (piece) span.append(piece);
    }
    return span;
  }

  function formatDate(value) {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return String(value);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/;

  // A value as the history gives it, typed by the column it came from. Null
  // draws nothing, as in the widget — an empty Old cell is how a first write
  // reads.
  function valueNode(value, dataType) {
    if (value == null) return null;
    if (Array.isArray(value)) {
      const ul = el("ul", "rh-list");
      const itemType = Array.isArray(dataType) ? dataType[0] : dataType;
      for (const item of value) {
        const li = el("li");
        const node = valueNode(item, itemType);
        if (node) li.append(node);
        ul.append(li);
      }
      return ul;
    }
    if (dataType === "signature" && typeof value === "object") {
      return document.createTextNode(String(value.userID ?? JSON.stringify(value)));
    }
    if (typeof value === "object") return el("code", "rh-json", JSON.stringify(value));
    if (typeof value === "string" && ISO_RE.test(value)) {
      const span = el("span", "", formatDate(value));
      span.title = value;
      return span;
    }
    if (typeof value === "string" && /^https?:\/\/\S+$/.test(value)) {
      const a = el("a", "rh-link", value);
      a.href = value;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return a;
    }
    return document.createTextNode(String(value));
  }

  // ── A combobox: a text field with a list under it ───────────────────────────

  // `source(query)` returns the options, or a promise of them. Typing is never
  // interrupted — the list repaints under the field, the field itself is left
  // alone — and what is typed always wins over what is listed.
  function combo({ placeholder, label, value, source, onText, onPick, onEnter, emptyText }) {
    const wrap = el("div", "rh-combo");
    const input = el("input", "rh-input");
    input.type = "text";
    input.placeholder = placeholder;
    input.value = value || "";
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-label", label);
    const panel = el("div", "rh-combo-panel");
    panel.hidden = true;
    panel.setAttribute("role", "listbox");

    let options = [];
    let active = -1;
    let seq = 0;
    let timer = null;

    function close() {
      seq++; // drop whatever is still in flight
      clearTimeout(timer);
      panel.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
    }

    function highlight() {
      panel.querySelectorAll(".rh-combo-opt").forEach((o, i) => {
        o.classList.toggle("rh-combo-active", i === active);
        if (i === active) o.scrollIntoView({ block: "nearest" });
      });
    }

    function pick(opt) {
      input.value = opt.value;
      close();
      onText(opt.value);
      onPick?.(opt);
    }

    function paint(note) {
      panel.textContent = "";
      active = -1;
      if (note) panel.append(el("p", "rh-combo-empty", note));
      options.forEach((opt) => {
        const btn = el("button", "rh-combo-opt");
        btn.type = "button";
        btn.setAttribute("role", "option");
        btn.append(el("span", "rh-combo-name", opt.label));
        if (opt.tag) btn.append(el("span", "rh-combo-tag", opt.tag));
        // mousedown, not click: the field must not blur (and close) first.
        btn.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(opt);
        });
        panel.append(btn);
      });
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
    }

    async function load() {
      const mine = ++seq;
      let found;
      try {
        found = source(input.value);
        if (found instanceof Promise) {
          if (panel.hidden) {
            options = [];
            paint("Loading…");
          }
          found = await found;
        }
      } catch (err) {
        if (mine !== seq) return;
        options = [];
        paint(`Couldn't load suggestions (${err.message}).`);
        return;
      }
      if (mine !== seq) return;
      options = found || [];
      paint(options.length === 0 ? emptyText(input.value) : "");
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(load, SUGGEST_DEBOUNCE_MS);
    }

    input.addEventListener("focus", load);
    input.addEventListener("input", () => {
      onText(input.value);
      schedule();
    });
    input.addEventListener("blur", close);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (panel.hidden) {
          load();
          return;
        }
        if (options.length === 0) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        active = (active + step + options.length) % options.length;
        highlight();
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!panel.hidden && active >= 0) pick(options[active]);
        else {
          close();
          onEnter?.();
        }
      } else if (e.key === "Escape" && !panel.hidden) {
        e.stopPropagation();
        close();
      }
    });

    // Dragging the list's scrollbar must not blur the field and close the list.
    panel.addEventListener("mousedown", (e) => e.preventDefault());

    wrap.append(input, panel);
    return { wrap, input };
  }

  // ── Controls ────────────────────────────────────────────────────────────────

  function field(labelText, control) {
    const box = el("label", "rh-field");
    box.append(el("span", "rh-field-label", labelText), control);
    return box;
  }

  function checkbox(labelText, key, onChange) {
    const box = el("label", "rh-check");
    const input = el("input");
    input.type = "checkbox";
    input.checked = state[key];
    input.addEventListener("change", () => {
      state[key] = input.checked;
      onChange();
    });
    box.append(input, labelText);
    return box;
  }

  // The quiet line under the controls: a table list that didn't load.
  function renderNotes() {
    const box = root?.querySelector(".rh-notes");
    if (!box) return;
    box.textContent = "";
    if (state.tablesError) box.append(el("p", "rh-note", state.tablesError));
  }

  let tableInput = null;

  // The left pane: where to look (the table) and what for (search),
  // then the records that match. Built once per mount; only the record list
  // under it is redrawn, so typing is never interrupted.
  function renderSide() {
    const side = el("div", "rh-side");

    const table = combo({
      placeholder: "Pick a table, or paste an id / URL",
      label: "Table",
      value: state.tableText,
      source: tableOptions,
      onText: (text) => {
        state.tableText = text;
      },
      onPick: () => {
        commitTable();
        search.focus();
      },
      onEnter: () => {
        commitTable();
        search.focus();
      },
      emptyText: () =>
        state.tables ? "No table matches. A pasted id or URL still works." : "Loading tables…",
    });
    tableInput = table.input;
    table.input.addEventListener("change", commitTable);
    side.append(field("Table", table.wrap));

    const search = el("input", "rh-input rh-search");
    search.type = "search";
    search.placeholder = "Search records — id or any text column";
    search.value = state.search;
    search.spellcheck = false;
    search.autocomplete = "off";
    search.setAttribute("aria-label", "Search records");
    search.addEventListener("input", () => {
      state.search = search.value;
      scheduleSearch();
    });
    // Enter opens the obvious answer: the record whose id is exactly what was
    // typed, or the only match. With no match at all the text is tried as an
    // id anyway — a deleted record is in no list but still has history.
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const q = state.search.trim();
      const rows = state.records || [];
      const hit = rows.find((r) => String(r.id) === q) || (rows.length === 1 ? rows[0] : null);
      if (hit) fetchHistory({ recordId: String(hit.id) });
      else if (q && rows.length === 0 && !state.recordsLoading) fetchHistory({ recordId: q });
    });
    side.append(field("Records", search));

    side.append(el("div", "rh-notes"), el("div", "rh-records"));
    return side;
  }

  // What a row says under its id: the column the search matched, so it is
  // clear why the row is here; otherwise the first couple of text values, so
  // rows with opaque ids can be told apart.
  function recordSummary(record, table, q) {
    const cols = textColumns(table);
    const text = (c) => (record[c.name] == null ? "" : String(record[c.name]));
    const needle = q.toLowerCase();
    if (needle && !String(record.id).toLowerCase().includes(needle)) {
      const hit = cols.find((c) => text(c).toLowerCase().includes(needle));
      if (hit) return `${hit.label || hit.name}: ${text(hit)}`;
    }
    return cols
      .map(text)
      .filter(Boolean)
      .slice(0, 2)
      .join(" · ");
  }

  const isShown = (recordId) =>
    Boolean(state.shown && state.table) &&
    state.shown.tableId === state.table.id &&
    state.shown.recordId === recordId;

  // Selection is a class, not a redraw: picking a record must not rebuild the
  // list under the cursor.
  function markSelected() {
    root?.querySelectorAll(".rh-record").forEach((btn) => {
      const on = isShown(btn.dataset.recordId);
      btn.classList.toggle("rh-record-on", on);
      btn.setAttribute("aria-current", on ? "true" : "false");
    });
  }

  function renderRecords() {
    const box = root?.querySelector(".rh-records");
    if (!box) return;
    box.textContent = "";
    const table = state.table;
    if (!table) {
      box.append(el("p", "rh-muted rh-records-note", "Pick a table to list its records."));
      return;
    }
    const q = state.search.trim();
    const rows = state.records || [];
    if (state.recordsError) box.append(el("p", "rh-note rh-records-note", state.recordsError));

    for (const record of rows) {
      const id = String(record.id);
      const btn = el("button", "rh-record");
      btn.type = "button";
      btn.dataset.recordId = id;
      btn.append(el("span", "rh-record-id", id));
      const summary = recordSummary(record, table, q);
      if (summary) btn.append(el("span", "rh-record-sub", summary));
      if (record._updatedAt) {
        btn.append(el("span", "rh-record-when", `Updated ${formatDate(record._updatedAt)}`));
      }
      btn.addEventListener("click", () => fetchHistory({ recordId: id }));
      box.append(btn);
    }

    if (state.recordsLoading) {
      box.append(el("p", "rh-muted rh-records-note", rows.length ? "Loading more…" : "Searching…"));
    } else if (!state.recordsError && rows.length === 0) {
      box.append(
        el("p", "rh-muted rh-records-note", q ? "No record matches." : "This table has no records."),
      );
    } else if (state.recordsMore) {
      const more = el("button", "rh-linkbtn rh-records-note", "Load more records");
      more.type = "button";
      more.addEventListener("click", () => searchRecords({ append: true }));
      box.append(more);
    }

    // The way to a record the list can't show. Offered whenever the text
    // isn't already one of the rows.
    if (q && !state.recordsLoading && !rows.some((r) => String(r.id) === q)) {
      const exact = el("button", "rh-linkbtn rh-records-note", `Look up “${q}” as an exact record id`);
      exact.type = "button";
      exact.title = "A deleted record is in no list, but its history is still there";
      exact.addEventListener("click", () => fetchHistory({ recordId: q }));
      box.append(exact);
    }
    markSelected();
  }

  function renderOptions() {
    const bar = el("div", "rh-options");
    const sort = el("select", "rh-select");
    sort.setAttribute("aria-label", "Order");
    for (const [value, text] of [
      ["asc", "Oldest first"],
      ["desc", "Newest first"],
    ]) {
      const opt = el("option", "", text);
      opt.value = value;
      sort.append(opt);
    }
    sort.value = state.sortDir;
    sort.addEventListener("change", () => {
      state.sortDir = sort.value;
      renderResult();
    });
    bar.append(sort);
    bar.append(checkbox("Hide old values", "hideOldValues", renderResult));
    // These two are the widget's own server-side switches, so they re-ask.
    const reload = () => fetchHistory({ again: true });
    bar.append(checkbox("Hide process data", "hideProcessData", reload));
    bar.append(checkbox("Signed completions only", "signedCompletionsOnly", reload));
    return bar;
  }

  // ── Drawing the history ─────────────────────────────────────────────────────

  const EVENT_TITLES = {
    create: "Created record",
    delete: "Deleted record",
    truncate: "Deleted all records in table.",
    variables: "Logged process data",
    update: "Updated record",
  };

  function eventTitle(event) {
    if (event.kind === "signature") return sentence("Signed: {form}", { form: strong(event.formName) });
    if (event.kind === "form") return sentence("Filled form {form}", { form: strong(event.formName) });
    return el("span", "rh-sentence", EVENT_TITLES[event.kind] || event.kind || "Event");
  }

  function labelNode(item) {
    const span = el("span", "rh-label", item.label ?? "");
    if (item.hidden) span.append(el("em", "rh-archived", " * Archived"));
    return span;
  }

  // label | value rows — everything that isn't a before/after edit.
  function plainRows(items) {
    const box = el("div", "rh-rows");
    for (const item of items) {
      const row = el("div", "rh-row");
      const value = el("div", "rh-row-value");
      const node = valueNode(item.value, item.dataType);
      if (node) value.append(node);
      row.append(labelNode(item), value);
      box.append(row);
    }
    return box;
  }

  // field | Old | New — a create or update.
  function editGrid(items) {
    const grid = el("div", state.hideOldValues ? "rh-grid rh-grid-2" : "rh-grid");
    if (!state.hideOldValues) {
      grid.append(el("span", "rh-grid-head"), el("span", "rh-grid-head", "Old"), el("span", "rh-grid-head", "New"));
    }
    for (const item of items) {
      grid.append(labelNode(item));
      if (!state.hideOldValues) {
        const old = el("div", "rh-old");
        const node = valueNode(item.previousValue, item.dataType);
        if (node) old.append(node);
        grid.append(old);
      }
      const next = el("div", "rh-new");
      const node = valueNode(item.value, item.dataType);
      if (node) next.append(node);
      grid.append(next);
    }
    return grid;
  }

  function card(titleNode, body, date) {
    const wrap = el("div", "rh-event");
    const box = el("div", "rh-card");
    const head = el("div", "rh-card-head");
    head.append(titleNode);
    box.append(head);
    if (body) box.append(body);
    wrap.append(box);
    if (date != null) wrap.append(el("div", "rh-when", formatDate(date)));
    return wrap;
  }

  function eventCard(event) {
    const items = Array.isArray(event.items) ? event.items : [];
    const isEdit = event.kind === "create" || event.kind === "update";
    const title = eventTitle(event);
    if (event.kind === "signature") title.append(el("span", "rh-signed", " ✓"));
    const body = items.length === 0 ? null : isEdit ? editGrid(items) : plainRows(items);
    return card(title, body, event.date);
  }

  // An e-signature carries its own context: who signed and why, the variables
  // captured with it, and the records that were loaded at the time.
  function eSigCard(event) {
    const info = event.eSigInfo;
    if (!info) return card(el("span", "rh-sentence", "Signature"), null, event.date);
    const body = el("div");
    body.append(
      plainRows([
        {
          label: `${info.widgetName}: ${info.meaning}`,
          dataType: "string",
          value: `${info.userName} (${info.userId})`,
        },
        { label: "Comment", dataType: "string", value: info.comment },
        ...(info.variables || []).map((v) => ({ label: v.name, dataType: v.type, value: v.value })),
      ]),
    );
    for (const rec of info.tableRecords || []) {
      const fields = rec.fields || [];
      body.append(
        sentence("{slot} from {table}", { slot: strong(rec.slotName), table: strong(rec.tableName) }),
      );
      if (fields.every((f) => f.value == null)) {
        body.append(el("p", "rh-muted", "No table record loaded"));
      } else {
        body.append(
          plainRows(fields.map((f) => ({ label: f.label, dataType: f.type, value: f.value }))),
        );
      }
    }
    body.classList.add("rh-esig");
    return card(sentence("Signed: {form}", { form: strong(info.widgetName) }), body, event.date);
  }

  function stepBlock(step) {
    const asc = state.sortDir === "asc";
    const events = asc ? step.events || [] : [...(step.events || [])].reverse();
    const template = step.isContinued
      ? "During step {step} (continued)"
      : step.startTime != null
        ? "Started step {step}"
        : "During step {step}";

    const head = el("div", "rh-event");
    const bar = el("div", "rh-card rh-step-head");
    bar.append(sentence(template, { step: strong(step.stepName) }));
    if (step.isCanceled) bar.append(el("span", "rh-badge", "Canceled"));
    head.append(bar);
    if (step.startTime != null && !step.isContinued) {
      head.append(el("div", "rh-when", formatDate(step.startTime)));
    }

    const block = el("div", step.isCanceled ? "rh-step rh-step-canceled" : "rh-step");
    const cards = events.map((e) => (e.kind === "eSig" ? eSigCard(e) : eventCard(e)));
    // A step opens with its heading, so reading newest-first it comes last.
    if (asc) block.append(head, ...cards);
    else block.append(...cards, head);
    return block;
  }

  const actorName = (group) =>
    group.possiblyCorrupted
      ? "A Service Account"
      : group.hydratedActor?.name || group.hydratedActor?._id || "Unknown user";

  // Who did it, and through what. `truncate` is a table-wide event, so the
  // wording says "the table" rather than "the record".
  function groupHeading(group) {
    const user = strong(actorName(group));
    const what = group.kind === "truncate" ? "table" : "record";
    switch (group.context) {
      case "app":
        return sentence("{user} ran {app} at station {station}", {
          user,
          app: strong(`${group.appName ?? ""} (${group.versionName ?? ""})`),
          station: strong(group.stationName),
        });
      case "admin":
        return sentence(`{user} updated the ${what} through the admin interface`, { user });
      case "api":
        return sentence(`{user} updated the ${what} through the Tulip API`, { user });
      case "automation":
        return sentence(`Automation {user} updated the ${what}`, { user });
      case "ai-agent": {
        const lead = group.actorType === "automation" ? "Automation" : "User";
        return sentence(`${lead} {user} updated the ${what} using agent {agent} in conversation {session}`, {
          user,
          agent: strong(group.aiContext?.agentName),
          session: strong(group.aiContext?.aiSessionId),
        });
      }
      default:
        return sentence(`{user} updated the ${what} through an unknown context`, { user });
    }
  }

  function groupBlock(group) {
    const asc = state.sortDir === "asc";
    const block = el("div", "rh-group");
    const head = el("div", "rh-group-head");
    head.append(groupHeading(group));
    block.append(head);
    const body = el("div", asc ? "rh-group-body" : "rh-group-body rh-group-body-desc");
    if (group.context === "app") {
      const steps = asc ? group.steps || [] : [...(group.steps || [])].reverse();
      body.append(...steps.map(stepBlock));
    } else {
      // Outside an app there are no steps: the group is itself the one event.
      body.append(eventCard(group));
    }
    block.append(body);
    return block;
  }

  // Shown at the old end of the list while the method is holding slices back.
  function limitNote() {
    const note = el("div", "rh-limit");
    note.append(
      sentence("Events recorded before {date} have not been loaded.", {
        date: strong(formatDate(state.minDate)),
      }),
    );
    const more = el("button", "rh-linkbtn", "Load more");
    more.type = "button";
    more.disabled = state.loading;
    more.addEventListener("click", () => fetchHistory({ more: true }));
    const all = el("button", "rh-linkbtn", "Load everything");
    all.type = "button";
    all.disabled = state.loading;
    all.addEventListener("click", () => fetchHistory({ more: true, all: true }));
    note.append(more, all);
    return note;
  }

  function renderResult() {
    const box = root?.querySelector(".rh-result");
    if (!box) return;
    box.textContent = "";
    if (!state.shown) {
      box.append(
        el(
          "p",
          "rh-muted rh-empty",
          "Pick a table on the left, then a record, to see that record's history here.",
        ),
      );
      return;
    }

    const head = el("div", "rh-head");
    const title = el("h2", "rh-title");
    title.append(strong(state.shown.tableName || state.shown.tableId), " – ", strong(state.shown.recordId));
    head.append(title);
    if (state.loading) head.append(el("span", "rh-muted", "Loading…"));
    if (!state.history) {
      box.append(head);
      if (state.error) box.append(el("div", "rh-banner", state.error));
      return;
    }
    box.append(head);
    if (state.error) box.append(el("div", "rh-banner", state.error));

    const asc = state.sortDir === "asc";
    const groups = asc ? state.history : [...state.history].reverse();
    const list = el("div", "rh-history");
    const limited = state.isLimited && state.minDate != null;
    if (limited && asc) list.append(limitNote());
    if (groups.length === 0) {
      list.append(
        el(
          "p",
          "rh-muted",
          "Tulip has no history for this record id in this table. Check the id — it is matched exactly — and that the table is in the workspace this tab is in.",
        ),
      );
    }
    list.append(...groups.map(groupBlock));
    if (limited && !asc) list.append(limitNote());
    box.append(list);
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const C = `#${CONTAINER_ID}`;
  const CSS = `
      ${C} { padding: 24px 40px; }
      ${C} .rh-disclaimer { background: #eef4fd; color: #45526b; border: 1px solid #c9dcf7; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
      ${C} .rh-banner { background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
      /* Two panes. The left one stays put while a long history scrolls, and
         scrolls its own record list instead of the page. */
      ${C} .rh-layout { display: flex; gap: 24px; align-items: flex-start; }
      ${C} .rh-side { flex: 0 0 340px; min-width: 0; position: sticky; top: 0; display: flex; flex-direction: column; gap: 10px; max-height: calc(100vh - 130px); }
      ${C} .rh-main { flex: 1 1 auto; min-width: 0; }
      ${C} .rh-records { flex: 1 1 auto; min-height: 120px; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; border: 1px solid #d5dae2; border-radius: 6px; background: #fff; }
      ${C} .rh-records-note { margin: 0; padding: 8px 10px; text-align: left; }
      ${C} .rh-records .rh-note { border-width: 0 0 1px; border-radius: 0; }
      ${C} .rh-record { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border: 0; border-bottom: 1px solid #e8edf5; border-left: 3px solid transparent; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
      ${C} .rh-record:hover { background: #f6f8fb; }
      ${C} .rh-record-on, ${C} .rh-record-on:hover { background: #eef4fd; border-left-color: #1c69e1; }
      ${C} .rh-record-id { font-weight: 600; overflow-wrap: anywhere; }
      ${C} .rh-record-sub { color: #45526b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      ${C} .rh-record-when { color: #aab2bf; font-size: 0.8em; }
      ${C} .rh-empty { margin: 40px 0; text-align: center; }
      ${C} .rh-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      ${C} .rh-field-label { font-size: 0.8em; font-weight: 600; color: #45526b; }
      ${C} .rh-input, ${C} .rh-select { font: inherit; padding: 6px 8px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; box-sizing: border-box; }
      ${C} .rh-input:focus, ${C} .rh-select:focus { outline: none; border-color: #1c69e1; }
      ${C} .rh-side .rh-input { width: 100%; }
      ${C} .rh-combo { position: relative; width: 100%; }
      ${C} .rh-combo-panel { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; right: 0; max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; background: #fff; border: 1px solid #d5dae2; border-radius: 6px; box-shadow: 0 6px 20px rgba(23, 33, 51, 0.14); }
      ${C} .rh-combo-panel[hidden] { display: none; }
      ${C} .rh-combo-opt { display: flex; gap: 10px; align-items: baseline; text-align: left; padding: 7px 10px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
      ${C} .rh-combo-opt:hover, ${C} .rh-combo-active { background: #eef4fd; }
      ${C} .rh-combo-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      ${C} .rh-combo-tag { flex: 0 0 auto; max-width: 55%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aab2bf; font-size: 0.8em; }
      ${C} .rh-combo-empty { color: #788293; margin: 0; padding: 8px 10px; }
      ${C} .rh-options { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; color: #45526b; }
      ${C} .rh-check { display: inline-flex; gap: 6px; align-items: center; cursor: pointer; }
      ${C} .rh-check input { margin: 0; }
      ${C} .rh-notes:empty { display: none; }
      ${C} .rh-notes { display: flex; flex-direction: column; gap: 6px; }
      ${C} .rh-note { margin: 0; color: #8a5a00; background: #fff6e5; border: 1px solid #f2ddb0; border-radius: 4px; padding: 6px 10px; }
      ${C} .rh-muted { color: #788293; }
      ${C} .rh-result { margin-top: 14px; max-width: 980px; }
      ${C} .rh-head { display: flex; gap: 12px; align-items: center; padding-bottom: 10px; border-bottom: 1px solid #d5dae2; }
      ${C} .rh-title { margin: 0; font-size: 1.2em; font-weight: 400; min-width: 0; overflow-wrap: anywhere; }
      ${C} .rh-history { display: flex; flex-direction: column; gap: 18px; padding: 16px 12px; background: #f6f8fb; border: 1px solid #e3e7ee; border-top: 0; border-radius: 0 0 6px 6px; }
      ${C} .rh-limit { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; color: #788293; }
      ${C} .rh-linkbtn { border: 0; background: none; padding: 0; font: inherit; color: #1c69e1; cursor: pointer; text-decoration: underline; }
      ${C} .rh-linkbtn:disabled { opacity: 0.5; cursor: default; }
      ${C} .rh-records .rh-linkbtn { padding: 8px 10px; }
      ${C} .rh-group-head { color: #45526b; }
      /* The rail down the left of a group is the widget's arrow: it points the
         way time runs, so it flips with the sort order. */
      ${C} .rh-group-body { position: relative; display: flex; flex-direction: column; gap: 12px; margin: 8px 0 0 15px; padding: 4px 0 14px 28px; border-left: 2px solid #c7ced9; }
      ${C} .rh-group-body::after { content: ""; position: absolute; left: -7px; bottom: 0; width: 12px; height: 12px; border-right: 2px solid #c7ced9; border-bottom: 2px solid #c7ced9; transform: rotate(45deg); }
      ${C} .rh-group-body-desc { padding: 14px 0 4px 28px; }
      ${C} .rh-group-body-desc::after { bottom: auto; top: 0; transform: rotate(-135deg); }
      ${C} .rh-step { display: flex; flex-direction: column; gap: 12px; }
      ${C} .rh-step-canceled { padding: 8px; background: #eceff3; border-radius: 3px; }
      ${C} .rh-step-canceled .rh-event { filter: grayscale(0.8) opacity(0.7); }
      ${C} .rh-step-head { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
      ${C} .rh-badge { padding: 2px 10px; border-radius: 10px; background: #dfe3ea; color: #45526b; font-size: 0.85em; }
      ${C} .rh-event { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
      ${C} .rh-card { padding: 8px 16px 12px; background: #fff; border: 1px solid #c7ced9; border-radius: 3px; color: #45526b; }
      ${C} .rh-step-head.rh-card { padding: 8px 16px; }
      ${C} .rh-card-head { margin-bottom: 8px; }
      ${C} .rh-card-head:last-child { margin-bottom: 0; }
      ${C} .rh-signed { color: #1d8a4c; font-weight: 700; }
      ${C} .rh-when { padding-left: 16px; color: #1a1f28; opacity: 0.5; font-size: 0.9em; }
      ${C} .rh-grid, ${C} .rh-rows, ${C} .rh-esig { background: #f6fafd; border: 1px solid #e3e7ee; border-radius: 4px; }
      ${C} .rh-esig > .rh-rows { border: 0; }
      ${C} .rh-esig > .rh-sentence, ${C} .rh-esig > .rh-muted { display: block; margin: 0; padding: 8px; border-top: 1px solid #e3e7ee; }
      ${C} .rh-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; max-width: 100%; }
      ${C} .rh-grid-2 { grid-template-columns: 1fr 1fr; }
      ${C} .rh-grid > * { padding: 8px; min-width: 0; overflow-wrap: anywhere; border-top: 1px solid #c7ced9; }
      ${C} .rh-grid > .rh-grid-head { border-top: 0; }
      ${C} .rh-grid-2 > :nth-child(-n + 2) { border-top: 0; }
      ${C} .rh-old { background: #fdecea; }
      ${C} .rh-new { background: #e6f6ec; }
      ${C} .rh-row { display: flex; gap: 12px; padding: 8px; border-top: 1px solid #e3e7ee; }
      ${C} .rh-row:first-child { border-top: 0; }
      ${C} .rh-row > .rh-label { flex: 0 0 160px; overflow-wrap: break-word; }
      ${C} .rh-row-value { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; color: #1a1f28; }
      ${C} .rh-archived { color: #788293; }
      ${C} .rh-list { margin: 0; padding-left: 18px; }
      ${C} .rh-json { font-size: 0.9em; white-space: pre-wrap; }
      ${C} .rh-link { color: #1c69e1; }
    `;

  // ── Mount ───────────────────────────────────────────────────────────────────

  function mount(container) {
    ensureStyles(STYLE_ID, CSS);
    root = container;
    container.append(
      el(
        "div",
        "rh-disclaimer",
        "The change history behind a table record — the same data Tulip's Record History widget shows, asked for the same way, with this browser session's own access. Nothing is stored or sent anywhere by Tulbelt.",
      ),
    );
    const layout = el("div", "rh-layout");
    const main = el("div", "rh-main");
    main.append(renderOptions(), el("div", "rh-result"));
    layout.append(renderSide(), main);
    container.append(layout);
    renderNotes();
    renderRecords();
    renderResult();
    // A table set before the tab was opened (the table-page button) has no
    // record list yet.
    if (state.table && !state.records) searchRecords();
    // After the first paint — a pasted table id works without the list.
    // Re-read on each mount so a table created since last visit shows up.
    loadTables();
  }

  function unmount() {
    clearTimeout(searchTimer);
    root = null;
    tableInput = null;
  }

  // ── The way in from a table page ────────────────────────────────────────────

  // Tulip's table page has a row of buttons at its top right: a ⋯ menu, the
  // CSV export, Queries, Aggregations, Create Record. Ours goes in beside the
  // export, as a copy of it — the classes are generated, so cloning is the
  // only way to wear them — with a history icon. A clone carries no React
  // fiber, so none of Tulip's handlers fire for it, and as a sibling React
  // didn't create, reconciliation leaves it alone; the toolbar can still be
  // remounted under it, hence the observer putting it back.
  const LINK_ID = "tulbelt-rh-table-link";
  const EXPORT_SELECTOR = "#table-download-csv";
  const TABLE_ROUTE = /^(?:\/w\/[^/]+)?\/table\/([^/?#]+)/;
  const HISTORY_ICON =
    "M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z";

  let linkObserver = null;
  let linkFrame = 0;

  const pageTableId = () => TABLE_ROUTE.exec(location.pathname)?.[1] || "";

  // The id is read from the URL at click time, so the button can't go stale
  // when Tulip moves between tables without a reload.
  function openForPageTable(e) {
    e.preventDefault();
    e.stopPropagation();
    const id = pageTableId();
    if (!id) return;
    if (state.table?.id !== id) {
      const listed = (state.tables || []).find((t) => t.id === id);
      state.table = listed || { id, name: "", columns: null };
      state.tableText = state.table.name || id;
      state.search = "";
      state.records = null;
      state.recordsError = "";
      state.history = null;
      state.shown = null;
      state.error = "";
    }
    window.__tulbeltPage.open("record-history");
  }

  function createLink(exportBtn) {
    const btn = exportBtn.cloneNode(true);
    btn.id = LINK_ID;
    btn.type = "button";
    btn.disabled = false;
    btn.setAttribute("aria-label", "Record history (Tulbelt)");
    btn.title = "Record history — browse this table's record history in Tulbelt";
    btn.querySelector("svg path")?.setAttribute("d", HISTORY_ICON);
    btn.addEventListener("click", openForPageTable);
    return btn;
  }

  function syncLink() {
    const existing = document.getElementById(LINK_ID);
    // Keyed on the export button alone, not the URL: while the Tulbelt page is
    // up the URL is ours, but the table page is still there underneath.
    const exportBtn = document.querySelector(EXPORT_SELECTOR);
    // The export sits in a wrapper of its own (Tulip's tooltip target); ours
    // goes in front of that wrapper, between the menu and the export.
    const slot = exportBtn?.parentElement;
    if (!slot?.parentElement) {
      existing?.remove();
      return;
    }
    if (existing && existing.nextElementSibling === slot) return;
    slot.before(existing || createLink(exportBtn));
  }

  function scheduleLinkSync() {
    if (linkFrame) return;
    linkFrame = requestAnimationFrame(() => {
      linkFrame = 0;
      syncLink();
    });
  }

  function startLink() {
    if (linkObserver) return;
    syncLink();
    linkObserver = new MutationObserver(scheduleLinkSync);
    linkObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopLink() {
    linkObserver?.disconnect();
    linkObserver = null;
    cancelAnimationFrame(linkFrame);
    linkFrame = 0;
    document.getElementById(LINK_ID)?.remove();
  }

  // ── Only where there is history to show ─────────────────────────────────────

  // `wanted` is the toggle; `exposed` is whether anything of ours is on the
  // page. Between them sits the question of whether this instance records
  // history at all (see record-history-main.js), which has three answers:
  // yes — expose; no — expose nothing, and stop asking; can't tell yet (not
  // signed in, Tulip still starting) — expose nothing and ask again.
  //
  // A yes is remembered per host, so the next page load on that instance
  // registers the tab straight away instead of a few seconds in — which is
  // what lets a reload on /tulbelt/record-history land back on this tab. The
  // memory is only a head start: the check still runs, and a no takes
  // everything back down and forgets the host.
  const AVAILABLE_KEY = "tulbelt:record-history-available";
  const AVAILABLE_TIMEOUT_MS = 20000;
  const RETRY_MS = [2000, 5000, 15000, 60000];

  let wanted = false;
  let exposed = false;
  let retryTimer = null;
  let tries = 0;

  function expose() {
    if (exposed) return;
    exposed = true;
    startLink();
    window.__tulbeltPage.register({
      id: "record-history",
      label: "Record History",
      containerId: CONTAINER_ID,
      order: 15,
      mount,
      unmount,
    });
  }

  function conceal() {
    if (!exposed) return;
    exposed = false;
    stopLink();
    window.__tulbeltPage.unregister("record-history");
    removeStyles(STYLE_ID);
  }

  async function knownHosts() {
    try {
      const { [AVAILABLE_KEY]: hosts = {} } = await chrome.storage.local.get(AVAILABLE_KEY);
      return hosts && typeof hosts === "object" ? hosts : {};
    } catch (_) {
      return {};
    }
  }

  async function remember(available) {
    try {
      const hosts = await knownHosts();
      if (Boolean(hosts[location.host]) === available) return;
      if (available) hosts[location.host] = true;
      else delete hosts[location.host];
      await chrome.storage.local.set({ [AVAILABLE_KEY]: hosts });
    } catch (_) {}
  }

  async function checkAvailable() {
    let answer = null;
    try {
      answer = await bridge("available", {}, AVAILABLE_TIMEOUT_MS);
    } catch (_) {}
    if (!wanted) return;
    if (answer?.known) {
      if (answer.enabled) expose();
      else conceal();
      remember(answer.enabled);
      return;
    }
    retryTimer = setTimeout(checkAvailable, RETRY_MS[Math.min(tries++, RETRY_MS.length - 1)]);
  }

  registerToggle(FEATURE_ID, {
    async onEnable() {
      wanted = true;
      tries = 0;
      const hosts = await knownHosts();
      if (!wanted) return;
      if (hosts[location.host]) expose();
      checkAvailable();
    },
    onDisable() {
      wanted = false;
      clearTimeout(retryTimer);
      conceal();
      // Let go of the plan subscription the check opened.
      bridge("release", {}, AVAILABLE_TIMEOUT_MS).catch(() => {});
    },
  });
})();
