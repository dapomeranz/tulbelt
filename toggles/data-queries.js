// The Data Queries tab of the Tulbelt page (shell: toggles/tulbelt-page.js).
//
// Paste a table id, build a filter/sort query against its columns, run it, and
// save it under a name. The requests are the same ones Tulip's own table page
// makes — /api/v3/w/<ws>/tables/<id>/records — issued from the tenant origin
// with the session's own credentials, so this shows exactly what the signed-in
// user is already allowed to see and nothing more.
//
// Auth comes from toggles/tulbelt-session-main.js, which captures the
// `Authorization` header Tulip's frontend sends and parks it on <html>. That's
// why there's no API-key field here: the session already has a credential, and
// asking the user to paste a permanent bot key would be both worse UX and a
// worse thing to have lying around. If no header has been captured yet — a cold
// load straight onto /tulbelt/data-queries, or the extension reloaded into an
// already-open tab — we fall back to cookies alone, which are same-origin and
// often enough on their own, and only then ask the user to visit a Tulip page.
//
// The filter vocabulary, saved-query shape, and URL serialisation all live in
// toggles/data-queries-model.js, which replicates @locus-ot/tulip-api's
// contract. This file is the UI over that model and owns no query semantics.
//
(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;
  const model = window.__tulbeltDataQueriesModel;

  const FEATURE_ID = "data-queries";
  const STYLE_ID = "tulbelt-dq-styles";
  const CONTAINER_ID = "tulbelt-dq-page";

  // Record fields Tulip owns. Shown after the user's own columns, and always
  // offered as filter/sort targets even when metadata didn't load.
  const META_FIELDS = ["_sequenceNumber", "_createdAt", "_updatedAt"];
  const META_LABELS = { _sequenceNumber: "Seq", _createdAt: "Created", _updatedAt: "Updated", id: "ID" };
  const META_TYPES = { _sequenceNumber: "integer", _createdAt: "timestamp", _updatedAt: "timestamp", id: "string" };

  // Survives switching tabs and coming back.
  const state = {
    store: null,
    storeError: "",
    query: null,
    columns: [], // [{ name, label, dataType }] filterable/sortable targets
    columnTypes: {}, // name -> dataType, for operator narrowing and coercion
    tableName: "",
    loading: false,
    error: "",
    hint: "",
    result: null,
    confirmDeleteId: null,
    savedFlash: "",
    exporting: false,
    exportCount: 0, // records fetched so far, for the in-progress readout
    cancelExport: false,
    // The point of this page is grabbing a saved query and seeing rows, so the
    // builder starts folded away on every query you open — filters are the
    // exception, not the entry point.
    optionsOpen: false,
    importing: false,
  };

  // ── Session ─────────────────────────────────────────────────────────────────

  const sessionAuth = () => document.documentElement.getAttribute("data-tulbelt-auth") || "";

  // The browser URL carries a workspace *slug* (/w/DEFAULT/...) but the API
  // wants the number (/api/v3/w/1/...), so it has to come off a real request.
  // The sniffer catches those live; performance entries cover the case where it
  // ran too late (extension reloaded into an open tab). Workspace 1 is the
  // default on single-workspace instances, which is most of them.
  function workspaceId() {
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

  function timeZone() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch (_) {
      return "UTC";
    }
  }

  // ── API ─────────────────────────────────────────────────────────────────────

  class ApiError extends Error {
    constructor(status, body) {
      super(`API error ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
      this.status = status;
    }
  }

  async function apiJson(path) {
    const url = `${location.origin}${path}`;
    const base = { Accept: "application/json", "time-zone": timeZone() };
    const auth = sessionAuth();

    const send = (headers) => fetch(url, { credentials: "include", headers });

    let resp = await send(auth ? { ...base, Authorization: auth } : base);
    // A sniffed header can be stale or scoped to something else. Cookies are
    // same-origin and may carry the session on their own, so a rejected header
    // is worth one retry without it rather than a dead end.
    if (auth && (resp.status === 401 || resp.status === 403)) resp = await send(base);

    if (!resp.ok) throw new ApiError(resp.status, await resp.text().catch(() => ""));
    return resp.json();
  }

  function fetchRecords(tableId, search) {
    return apiJson(`/api/v3/w/${workspaceId()}/tables/${encodeURIComponent(tableId)}/records?${search}`);
  }

  function fetchTableMeta(tableId) {
    return apiJson(`/api/v3/w/${workspaceId()}/tables/${encodeURIComponent(tableId)}`);
  }

  // ── Columns ─────────────────────────────────────────────────────────────────

  // Tulip prefixes user field ids with a five-character handle
  // (`mreav_product_name`), so a readable label falls out of the id alone. This
  // is the fallback when the table metadata call doesn't land — it means the
  // grid is still legible without depending on a response shape we only infer.
  function labelFromFieldId(fieldId) {
    return (
      fieldId
        .replace(/^[a-z0-9]{5}_/, "")
        .split("_")
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ") || fieldId
    );
  }

  // TableMetadata.columns is TableField[]: { name, label, dataType: { type } }.
  // Read it defensively anyway — this is a private endpoint and a shape we only
  // have second-hand.
  function columnsFromMeta(meta) {
    const cols = meta?.columns || meta?.fields || [];
    if (!Array.isArray(cols)) return [];
    return cols
      .filter((c) => c && !c.hidden && !c.deleted)
      .map((c) => ({
        name: c.fieldId || c.name || c.id,
        label: c.label || c.displayName || c.name,
        dataType: c.dataType?.type || c.dataType || c.type || "",
      }))
      .filter((c) => typeof c.name === "string" && c.name);
  }

  function labelFor(key) {
    const col = state.columns.find((c) => c.name === key);
    if (col?.label) return col.label;
    return META_LABELS[key] || labelFromFieldId(key);
  }

  // Records omit fields they have no value for, so the column set is the union
  // across the page, in first-seen order. `id` leads, Tulip's own fields trail.
  function resultColumns(rows) {
    const seen = new Set();
    for (const row of rows) for (const k of Object.keys(row)) seen.add(k);
    const userKeys = [...seen].filter((k) => k !== "id" && !META_FIELDS.includes(k));
    return [
      ...(seen.has("id") ? ["id"] : []),
      ...userKeys,
      ...META_FIELDS.filter((k) => seen.has(k)),
    ].map((key) => ({ key, label: labelFor(key) }));
  }

  // Filter/sort targets: the table's own columns plus the record fields Tulip
  // always provides. Available even with no metadata, so a query is still
  // buildable against `id` and the timestamps.
  function setColumns(cols) {
    const metaCols = ["id", ...META_FIELDS].map((name) => ({
      name,
      label: META_LABELS[name] || name,
      dataType: META_TYPES[name] || "",
    }));
    const seen = new Set(cols.map((c) => c.name));
    state.columns = [...cols, ...metaCols.filter((c) => !seen.has(c.name))];
    state.columnTypes = Object.fromEntries(state.columns.map((c) => [c.name, c.dataType]));
  }

  // ── Load ────────────────────────────────────────────────────────────────────

  // Accept a bare id or anything containing one — a pasted table URL is the
  // obvious thing to reach for, and picking the id out of it is free.
  function parseTableId(raw) {
    const text = String(raw || "").trim();
    if (!text) return "";
    const fromUrl = /\/table\/([A-Za-z0-9_-]+)/.exec(text);
    if (fromUrl) return fromUrl[1];
    return /^[A-Za-z0-9_-]+$/.test(text) ? text : "";
  }

  function explainFailure(err) {
    if (err instanceof ApiError) {
      if (err.status === 401 || err.status === 403) {
        return sessionAuth()
          ? "Tulip rejected this session's credentials. Reload a Tulip page in this tab, then try again."
          : "Not authorised, and no session credentials have been captured yet. Open any Tulip page in this tab (a table works well), then come back and retry.";
      }
      if (err.status === 404) return "No table with that id in this workspace.";
      if (err.status === 400) return `Tulip rejected the query. ${err.message}`;
    }
    return err.message || String(err);
  }

  // The front half of both Run and Export: settle on a table id and prove the
  // builder rows compile. Returns "" after putting the reason on screen.
  function prepare() {
    const tableId = parseTableId(state.query.tableId);
    if (!tableId) {
      state.error = "That doesn't look like a table id. Paste the id itself or the table's URL.";
      state.result = null;
      render();
      return "";
    }
    state.query.tableId = tableId;

    const { error } = paramsFor(0);
    if (error) {
      state.error = error;
      render();
      return "";
    }
    return tableId;
  }

  const paramsFor = (offset) =>
    model.queryToParams({ ...state.query, columnTypes: state.columnTypes }, { offset });

  // Every response shape Tulip has handed back for a records call.
  const recordsOf = (payload) => (Array.isArray(payload) ? payload : payload?.records || []);

  async function run({ reloadSchema = false } = {}) {
    const tableId = prepare();
    if (!tableId) return;
    const { search } = paramsFor(0);

    state.loading = true;
    state.error = "";
    state.hint = "";
    state.savedFlash = "";
    render();

    state.store.lastTableId = tableId;
    persist();

    try {
      const needsSchema = reloadSchema || state.columns.length === 0;
      // Labels are a nicety; never let them fail the run.
      const [records, meta] = await Promise.all([
        fetchRecords(tableId, search),
        needsSchema ? fetchTableMeta(tableId).catch(() => null) : Promise.resolve(null),
      ]);
      if (needsSchema) {
        const cols = columnsFromMeta(meta);
        setColumns(cols);
        state.tableName = meta?.label || meta?.name || "";
        if (!meta) {
          state.hint =
            "Table metadata didn't load — column names are derived from field ids, and every operator is offered since column types are unknown.";
        }
      }
      const rows = recordsOf(records);
      // With no metadata the only known columns are whatever came back.
      if (state.columns.length <= 1 + META_FIELDS.length && rows.length) {
        const discovered = [...new Set(rows.flatMap((r) => Object.keys(r)))]
          .filter((k) => k !== "id" && !META_FIELDS.includes(k))
          .map((name) => ({ name, label: labelFromFieldId(name), dataType: "" }));
        setColumns(discovered);
      }
      state.result = {
        rows,
        columns: resultColumns(rows),
        truncated: rows.length >= model.normalizeLimit(state.query.limit),
      };
    } catch (err) {
      state.error = explainFailure(err);
      state.result = null;
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── CSV export ──────────────────────────────────────────────────────────────

  // A runaway guard, not a policy: 100k records is already far past what a
  // spreadsheet wants, and a query that somehow never returns an empty page
  // shouldn't be able to loop forever.
  const EXPORT_PAGE_CAP = 1000;

  // RFC 4180. Quote anything holding a comma, a quote, or a newline, and double
  // up the quotes inside. Objects go in as JSON, which is how the grid shows
  // them too.
  function csvValue(value) {
    if (value == null) return "";
    const text = typeof value === "object" ? JSON.stringify(value) : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  // CRLF and a leading BOM: what Excel needs to read UTF-8 without mangling it,
  // and what every other tool ignores harmlessly.
  function csvFrom(rows, columns) {
    const lines = [columns.map((c) => csvValue(c.label)).join(",")];
    for (const row of rows) lines.push(columns.map((c) => csvValue(row[c.key])).join(","));
    return `\uFEFF${lines.join("\r\n")}\r\n`;
  }

  function csvFilename(tableId, count) {
    const base =
      (state.tableName || tableId).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "table";
    return `${base}-${new Date().toISOString().slice(0, 10)}-${count}-records.csv`;
  }

  // A blob URL rather than a data: URI — a full-table export runs to megabytes,
  // well past what a URL will carry.
  function downloadFile(text, filename, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Chrome needs the URL alive through the click; free it on the next turn.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Export walks the same query the grid ran, one page at a time, until a page
  // comes back empty — Run only ever shows the first page, so this is the only
  // way to get the whole answer out. Each page is a separate request carrying
  // the session's own credentials, exactly like Run.
  async function exportCsv() {
    const tableId = prepare();
    if (!tableId) return;

    state.exporting = true;
    state.cancelExport = false;
    state.exportCount = 0;
    state.error = "";
    state.hint = "";
    state.savedFlash = "";
    render();

    const rows = [];
    let stoppedShort = "";
    try {
      for (let page = 0; ; page += 1) {
        if (state.cancelExport) {
          stoppedShort = "Export cancelled — the file holds the pages already fetched.";
          break;
        }
        if (page >= EXPORT_PAGE_CAP) {
          stoppedShort = `Stopped after ${EXPORT_PAGE_CAP} pages — the file holds what was fetched. Narrow the query to get the rest.`;
          break;
        }
        const { search } = paramsFor(page * model.normalizeLimit(state.query.limit));
        const batch = recordsOf(await fetchRecords(tableId, search));
        if (batch.length === 0) break;
        rows.push(...batch);
        state.exportCount = rows.length;
        render();
      }

      if (rows.length === 0) {
        state.hint = stoppedShort || "Nothing to export — the query matched no records.";
        return;
      }
      downloadFile(
        csvFrom(rows, resultColumns(rows)),
        csvFilename(tableId, rows.length),
        "text/csv;charset=utf-8"
      );
      state.savedFlash = `Exported ${rows.length} record${rows.length === 1 ? "" : "s"} to CSV.`;
      if (stoppedShort) state.hint = stoppedShort;
    } catch (err) {
      state.error = `${explainFailure(err)}${
        rows.length ? ` — gave up after ${rows.length} records, nothing was downloaded.` : ""
      }`;
    } finally {
      state.exporting = false;
      state.cancelExport = false;
      render();
    }
  }

  // ── Saved queries ───────────────────────────────────────────────────────────

  function persist() {
    const { error } = model.saveStore(state.store);
    state.storeError = error || "";
  }

  function saveCurrent() {
    const name = state.query.name.trim();
    if (!name) {
      state.error = "Give the query a name before saving it.";
      render();
      return;
    }
    const { filters, error } = model.compileFilters(state.query.rows, state.columnTypes);
    if (error) {
      state.error = error;
      render();
      return;
    }
    const saved = model.toSaved(state.query, filters);
    state.query.id = saved.id;
    state.query.createdAt = saved.createdAt;
    model.upsertQuery(state.store, saved);
    persist();
    state.error = "";
    state.savedFlash = `Saved “${saved.name}”.`;
    render();
  }

  function loadSaved(id, flash = "") {
    const saved = state.store.queries.find((q) => q.id === id);
    if (!saved) return;
    state.query = model.fromSaved(saved);
    state.result = null;
    state.error = "";
    state.hint = "";
    state.savedFlash = "";
    state.confirmDeleteId = null;
    state.importing = false;
    state.optionsOpen = false;
    // A different table means the columns in hand no longer describe it.
    state.columns = [];
    state.columnTypes = {};
    state.tableName = "";
    // The run clears the flash on its way through, so it lands afterwards.
    run({ reloadSchema: true }).then(() => {
      if (!flash) return;
      state.savedFlash = flash;
      render();
    });
  }

  function newQuery() {
    state.query = model.emptyQuery(state.query?.tableId || state.store.lastTableId || "");
    state.result = null;
    state.error = "";
    state.savedFlash = "";
    state.confirmDeleteId = null;
    state.importing = false;
    state.optionsOpen = false;
    render();
  }

  // ── UI ──────────────────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function select(className, options, value, onChange) {
    const sel = el("select", className);
    for (const opt of options) {
      const o = el("option", null, opt.label);
      o.value = opt.value;
      if (opt.value === value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener("change", () => onChange(sel.value));
    return sel;
  }

  const fieldOptions = () =>
    state.columns.map((c) => ({ value: c.name, label: c.label || c.name }));

  // ── Builder ─────────────────────────────────────────────────────────────────

  function renderFilterRow(row, index) {
    const wrap = el("div", "dq-row");

    wrap.appendChild(
      select("dq-select dq-field", [{ value: "", label: "Choose a field…" }, ...fieldOptions()], row.field, (v) => {
        row.field = v;
        // The new column may not offer the operator that was selected.
        const allowed = model.operatorsForType(state.columnTypes[v]);
        if (!allowed.some((o) => o.id === row.functionType)) row.functionType = allowed[0].id;
        render();
      })
    );

    const ops = model.operatorsForType(state.columnTypes[row.field]);
    if (!row.functionType) row.functionType = ops[0].id;
    wrap.appendChild(
      select("dq-select dq-op", ops.map((o) => ({ value: o.id, label: o.label })), row.functionType, (v) => {
        row.functionType = v;
        render();
      })
    );

    const op = model.OPERATOR_BY_ID.get(row.functionType);
    if (op && op.arity !== 0) {
      const input = el("input", "dq-input dq-value");
      input.type = "text";
      input.value = row.value ?? "";
      input.placeholder = op.arity === "list" ? "a, b, c" : "value";
      if (op.arity === "list") input.title = "Comma-separated; sent as a list";
      // Deliberately no re-render on input — that would drop the caret.
      input.addEventListener("input", () => {
        row.value = input.value;
      });
      wrap.appendChild(input);
    } else {
      wrap.appendChild(el("span", "dq-novalue", "—"));
    }

    const remove = el("button", "dq-btn dq-btn-icon", "×");
    remove.type = "button";
    remove.title = "Remove this filter";
    remove.addEventListener("click", () => {
      state.query.rows.splice(index, 1);
      render();
    });
    wrap.appendChild(remove);
    return wrap;
  }

  function renderSortRow(sort, index) {
    const wrap = el("div", "dq-row");
    wrap.appendChild(
      select("dq-select dq-field", fieldOptions(), sort.sortBy, (v) => {
        sort.sortBy = v;
      })
    );
    wrap.appendChild(
      select(
        "dq-select dq-op",
        [{ value: "desc", label: "newest / Z→A" }, { value: "asc", label: "oldest / A→Z" }],
        sort.sortDir,
        (v) => {
          sort.sortDir = v;
        }
      )
    );
    const remove = el("button", "dq-btn dq-btn-icon", "×");
    remove.type = "button";
    remove.title = "Remove this sort";
    remove.addEventListener("click", () => {
      state.query.sortOptions.splice(index, 1);
      render();
    });
    wrap.appendChild(remove);
    return wrap;
  }

  // A one-line read of what is folded away, so the collapsed state still says
  // what the query does.
  function optionsSummary() {
    const filters = state.query.rows.filter((r) => r.field).length;
    const sorts = state.query.sortOptions
      .map((o) => `${labelFor(o.sortBy)} ${o.sortDir === "asc" ? "↑" : "↓"}`)
      .join(", ");
    return [
      filters === 0 ? "no filters" : `${filters} filter${filters === 1 ? "" : "s"}`,
      sorts ? `sorted by ${sorts}` : "unsorted",
    ].join(" · ");
  }

  function renderBuilder() {
    const box = el("section", "dq-builder");

    // Name. Up top because it is the query's identity, and because naming it is
    // what turns a one-off into something the list can hand back later.
    const nameInput = el("input", "dq-input dq-name");
    nameInput.type = "text";
    nameInput.placeholder = "Name this query";
    nameInput.value = state.query.name;
    nameInput.setAttribute("aria-label", "Query name");
    // No re-render on input — that would drop the caret mid-name. The Save
    // button re-reads the name on click, so it stays in step without one.
    nameInput.addEventListener("input", () => {
      state.query.name = nameInput.value;
      const save = box.querySelector(".dq-btn-save");
      if (save) save.disabled = !nameInput.value.trim();
    });
    box.appendChild(nameInput);

    // Table id.
    const tableRow = el("div", "dq-table-row");
    const tableInput = el("input", "dq-input dq-table-input");
    tableInput.type = "text";
    tableInput.placeholder = "Table id (e.g. Sb28KTCAWbt6PLm5f) or a table URL";
    tableInput.value = state.query.tableId;
    tableInput.spellcheck = false;
    tableInput.setAttribute("aria-label", "Table id");
    tableInput.addEventListener("input", () => {
      state.query.tableId = tableInput.value;
    });
    tableInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        run({ reloadSchema: true });
      }
    });
    const loadBtn = el("button", "dq-btn", "Load table");
    loadBtn.type = "button";
    loadBtn.title = "Fetch this table's columns, then run the query";
    loadBtn.addEventListener("click", () => run({ reloadSchema: true }));
    tableRow.appendChild(tableInput);
    tableRow.appendChild(loadBtn);
    if (state.tableName) tableRow.appendChild(el("span", "dq-table-name", state.tableName));
    box.appendChild(tableRow);

    if (state.columns.length === 0) {
      box.appendChild(
        el("p", "dq-hint", "Load a table to build a query against its columns.")
      );
      return box;
    }

    // Filters and sort, folded away by default.
    const disclosure = el("button", "dq-disclosure");
    disclosure.type = "button";
    disclosure.setAttribute("aria-expanded", String(state.optionsOpen));
    disclosure.appendChild(el("span", "dq-caret", state.optionsOpen ? "▾" : "▸"));
    disclosure.appendChild(el("span", null, "Filters & sort"));
    disclosure.appendChild(el("span", "dq-disclosure-meta", optionsSummary()));
    disclosure.addEventListener("click", () => {
      state.optionsOpen = !state.optionsOpen;
      render();
    });
    box.appendChild(disclosure);

    const opts = el("div", "dq-options");
    if (!state.optionsOpen) opts.hidden = true;
    box.appendChild(opts);

    // Filters.
    const filterHead = el("div", "dq-section-head");
    filterHead.appendChild(el("span", null, "Match"));
    filterHead.appendChild(
      select(
        "dq-select dq-agg",
        [{ value: "all", label: "all" }, { value: "any", label: "any" }],
        state.query.filterAggregator,
        (v) => {
          state.query.filterAggregator = v;
        }
      )
    );
    filterHead.appendChild(el("span", null, "of these filters:"));
    opts.appendChild(filterHead);

    const filters = el("div", "dq-rows");
    state.query.rows.forEach((row, i) => filters.appendChild(renderFilterRow(row, i)));
    if (state.query.rows.length === 0) {
      filters.appendChild(el("p", "dq-hint", "No filters — every record is returned."));
    }
    opts.appendChild(filters);

    const addFilter = el("button", "dq-btn dq-btn-small", "+ Add filter");
    addFilter.type = "button";
    addFilter.addEventListener("click", () => {
      state.query.rows.push({ field: "", functionType: "", value: "" });
      render();
    });
    opts.appendChild(addFilter);

    // Sort.
    opts.appendChild(el("div", "dq-section-head", "Sort by:"));
    const sorts = el("div", "dq-rows");
    state.query.sortOptions.forEach((s, i) => sorts.appendChild(renderSortRow(s, i)));
    if (state.query.sortOptions.length === 0) {
      sorts.appendChild(el("p", "dq-hint", "Unsorted — Tulip's default order."));
    }
    opts.appendChild(sorts);

    const addSort = el("button", "dq-btn dq-btn-small", "+ Add sort");
    addSort.type = "button";
    addSort.addEventListener("click", () => {
      state.query.sortOptions.push({ sortBy: state.columns[0].name, sortDir: "desc" });
      render();
    });
    opts.appendChild(addSort);

    // Actions.
    const actions = el("div", "dq-actions");

    const runBtn = el(
      "button",
      "dq-btn dq-btn-primary",
      state.loading ? "Running…" : `Run (first ${model.normalizeLimit(state.query.limit)})`
    );
    runBtn.type = "button";
    runBtn.disabled = state.loading || state.exporting;
    runBtn.addEventListener("click", () => run());
    actions.appendChild(runBtn);

    const exportBtn = el("button", "dq-btn", state.exporting ? "Exporting…" : "Export CSV");
    exportBtn.type = "button";
    exportBtn.title = "Page through every matching record and download them all as a CSV";
    exportBtn.disabled = state.loading || state.exporting;
    exportBtn.addEventListener("click", exportCsv);
    actions.appendChild(exportBtn);

    if (state.exporting) {
      actions.appendChild(el("span", "dq-note", `${state.exportCount} fetched…`));
      const cancelBtn = el("button", "dq-btn dq-btn-small", "Cancel");
      cancelBtn.type = "button";
      // Takes effect between pages; the request already in flight still lands.
      cancelBtn.addEventListener("click", () => {
        state.cancelExport = true;
      });
      actions.appendChild(cancelBtn);
    }

    const saveBtn = el("button", "dq-btn dq-btn-save", state.query.id ? "Save" : "Save query");
    saveBtn.type = "button";
    saveBtn.disabled = !state.query.name.trim();
    saveBtn.title = state.query.name.trim() ? "" : "Name the query up top to save it";
    saveBtn.addEventListener("click", saveCurrent);
    actions.appendChild(saveBtn);

    box.appendChild(actions);
    return box;
  }

  // ── Share a query ───────────────────────────────────────────────────────────

  // Same trade as the option-sets export: JSON on the clipboard, not a file.
  // A query is small, and pasting into chat is how these actually travel.
  function copyQuery(saved, btn) {
    const text = JSON.stringify(model.toPortable(saved), null, 2);
    navigator.clipboard.writeText(text).then(
      () => {
        const was = btn.textContent;
        btn.textContent = "✓";
        setTimeout(() => {
          if (btn.isConnected) btn.textContent = was;
        }, 1500);
      },
      (err) => {
        state.error = `Couldn't copy to clipboard: ${err.message}`;
        render();
      }
    );
  }

  function renderImportForm() {
    const form = el("section", "dq-builder");
    form.appendChild(el("h2", "dq-import-head", "Import queries"));
    form.appendChild(
      el(
        "p",
        "dq-hint",
        "Paste an export from another Tulbelt user. Imported queries are added alongside your existing ones — a name already in use gets a number."
      )
    );

    const error = el("div", "dq-banner");
    error.style.display = "none";
    form.appendChild(error);

    const text = el("textarea", "dq-input dq-import-text");
    text.rows = 10;
    text.spellcheck = false;
    text.placeholder = '{ "tulbelt": "data-queries", ... }';
    form.appendChild(text);

    const actions = el("div", "dq-actions");
    const doImport = el("button", "dq-btn dq-btn-primary", "Import");
    doImport.type = "button";
    doImport.addEventListener("click", () => {
      const result = model.parseImport(text.value);
      if (result.error) {
        // No re-render — keep the pasted text so the user can fix it in place.
        error.textContent = result.error;
        error.style.display = "";
        return;
      }
      for (const q of result.queries) {
        q.name = model.uniqueName(state.store, q.name);
        model.upsertQuery(state.store, q);
      }
      persist();
      state.importing = false;
      const n = result.queries.length;
      // Land on the first import rather than making the user hunt for it.
      loadSaved(result.queries[0].id, `Imported ${n} quer${n === 1 ? "y" : "ies"}.`);
    });
    const cancel = el("button", "dq-btn", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => {
      state.importing = false;
      render();
    });
    actions.appendChild(doImport);
    actions.appendChild(cancel);
    form.appendChild(actions);
    return form;
  }

  // ── Saved query list ────────────────────────────────────────────────────────

  function renderSaved() {
    const panel = el("aside", "dq-saved");

    const tools = el("div", "dq-saved-tools");
    const newBtn = el("button", "dq-btn dq-btn-primary", "+ New query");
    newBtn.type = "button";
    newBtn.addEventListener("click", newQuery);
    tools.appendChild(newBtn);

    const importBtn = el("button", "dq-btn", "Import");
    importBtn.type = "button";
    importBtn.title = "Paste queries exported from another Tulbelt user";
    importBtn.addEventListener("click", () => {
      state.importing = true;
      state.confirmDeleteId = null;
      render();
    });
    tools.appendChild(importBtn);
    panel.appendChild(tools);

    if (state.store.queries.length === 0) {
      panel.appendChild(el("p", "dq-hint", "No saved queries yet. Build one, name it, and hit Save."));
      return panel;
    }

    const list = el("div", "dq-saved-list");
    for (const q of state.store.queries) {
      const row = el("div", "dq-saved-row");
      if (q.id === state.query.id) row.classList.add("dq-selected");

      const open = el("button", "dq-saved-open");
      open.type = "button";
      open.appendChild(el("span", "dq-saved-name", q.name));
      const count = q.filters?.length || 0;
      open.appendChild(
        el("span", "dq-saved-meta", `${q.tableId} · ${count} filter${count === 1 ? "" : "s"}`)
      );
      open.addEventListener("click", () => loadSaved(q.id));
      row.appendChild(open);

      if (state.confirmDeleteId === q.id) {
        const yes = el("button", "dq-btn dq-btn-danger dq-btn-icon", "Delete");
        yes.type = "button";
        yes.addEventListener("click", () => {
          model.removeQuery(state.store, q.id);
          if (state.query.id === q.id) state.query.id = null;
          state.confirmDeleteId = null;
          persist();
          render();
        });
        const no = el("button", "dq-btn dq-btn-icon", "Cancel");
        no.type = "button";
        no.addEventListener("click", () => {
          state.confirmDeleteId = null;
          render();
        });
        row.appendChild(yes);
        row.appendChild(no);
      } else {
        const share = el("button", "dq-btn dq-btn-icon", "⧉");
        share.type = "button";
        share.title = `Copy “${q.name}” as JSON to share`;
        share.addEventListener("click", () => copyQuery(q, share));
        row.appendChild(share);

        const del = el("button", "dq-btn dq-btn-icon", "×");
        del.type = "button";
        del.title = `Delete “${q.name}”`;
        del.addEventListener("click", () => {
          state.confirmDeleteId = q.id;
          render();
        });
        row.appendChild(del);
      }
      list.appendChild(row);
    }
    panel.appendChild(list);
    return panel;
  }

  // ── Results ─────────────────────────────────────────────────────────────────

  const ISO_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/;

  function renderCell(key, value) {
    const cell = el("td");
    const box = el("div", "dq-cell");
    if (value == null || value === "") {
      box.classList.add("dq-empty");
      box.textContent = "—";
    } else if (typeof value === "object") {
      box.textContent = JSON.stringify(value);
      box.title = box.textContent;
    } else {
      const text = String(value);
      if (/^https?:\/\//i.test(text)) {
        const a = el("a", null, text);
        a.href = text;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = text;
        box.appendChild(a);
      } else if (META_FIELDS.includes(key) && ISO_RE.test(text)) {
        // Raw stays on hover — the exact stamp is sometimes the point.
        box.textContent = new Date(text).toLocaleString();
        box.title = text;
      } else {
        box.textContent = text;
        box.title = text;
      }
    }
    cell.appendChild(box);
    return cell;
  }

  function renderResult(result) {
    const wrap = el("div", "dq-result");

    const summary = el("div", "dq-summary");
    const count = result.rows.length;
    summary.appendChild(
      el("span", "dq-count", count === 0 ? "No records" : `${count} record${count === 1 ? "" : "s"}`)
    );
    if (result.truncated) {
      summary.appendChild(
        el(
          "span",
          "dq-note",
          `first ${model.normalizeLimit(state.query.limit)} shown — Export CSV for every match`
        )
      );
    }
    wrap.appendChild(summary);

    if (count === 0) {
      wrap.appendChild(el("p", "dq-hint", "Nothing matched. Loosen a filter, or switch Match all to Match any."));
      return wrap;
    }

    const scroller = el("div", "dq-scroll");
    const table = el("table", "dq-table");
    const thead = el("thead");
    const headRow = el("tr");
    for (const col of result.columns) {
      const th = el("th", null, col.label);
      // The raw field id is what you need when writing a query against it.
      if (col.label !== col.key) th.title = col.key;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = el("tbody");
    for (const row of result.rows) {
      const tr = el("tr");
      for (const col of result.columns) tr.appendChild(renderCell(col.key, row[col.key]));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    scroller.appendChild(table);
    wrap.appendChild(scroller);
    return wrap;
  }

  function render() {
    const root = document.querySelector(`#${CONTAINER_ID} .dq-root`);
    if (!root) return;
    root.textContent = "";

    if (state.storeError) root.appendChild(el("div", "dq-banner", state.storeError));

    const layout = el("div", "dq-layout");
    layout.appendChild(renderSaved());

    const main = el("div", "dq-main");
    if (state.importing) {
      main.appendChild(renderImportForm());
      layout.appendChild(main);
      root.appendChild(layout);
      return;
    }
    main.appendChild(renderBuilder());
    if (state.error) main.appendChild(el("div", "dq-banner", state.error));
    if (state.hint) main.appendChild(el("div", "dq-note-banner", state.hint));
    if (state.savedFlash) main.appendChild(el("div", "dq-flash", state.savedFlash));

    if (state.loading) main.appendChild(el("p", "dq-hint", "Fetching records…"));
    else if (state.result) main.appendChild(renderResult(state.result));

    layout.appendChild(main);
    root.appendChild(layout);
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const CSS = `
      #${CONTAINER_ID} { padding: 24px 40px; }
      #${CONTAINER_ID} .dq-disclaimer { background: #eef4fd; color: #45526b; border: 1px solid #c9dcf7; border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
      #${CONTAINER_ID} .dq-banner { background: #fdecea; color: #b3261e; border: 1px solid #f5c6c2; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
      #${CONTAINER_ID} .dq-note-banner { background: #fff6e5; color: #8a5a00; border: 1px solid #f2ddb0; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
      #${CONTAINER_ID} .dq-flash { background: #e9f7ef; color: #1d6b3c; border: 1px solid #b8e2c8; border-radius: 4px; padding: 8px 12px; margin: 12px 0; }
      #${CONTAINER_ID} .dq-layout { display: flex; gap: 24px; align-items: flex-start; }
      #${CONTAINER_ID} .dq-saved { flex: 0 0 240px; display: flex; flex-direction: column; gap: 8px; }
      #${CONTAINER_ID} .dq-saved-list { display: flex; flex-direction: column; gap: 4px; }
      #${CONTAINER_ID} .dq-saved-row { display: flex; gap: 4px; align-items: stretch; }
      #${CONTAINER_ID} .dq-saved-open { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; padding: 8px 10px; border: 1px solid #d5dae2; border-radius: 6px; background: #fff; color: inherit; cursor: pointer; font: inherit; }
      #${CONTAINER_ID} .dq-saved-open:hover { border-color: #1c69e1; }
      #${CONTAINER_ID} .dq-selected .dq-saved-open { border-color: #1c69e1; background: #eef4fd; }
      #${CONTAINER_ID} .dq-saved-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-saved-meta { color: #788293; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-main { flex: 1 1 auto; min-width: 0; }
      #${CONTAINER_ID} .dq-builder { border: 1px solid #d5dae2; border-radius: 6px; padding: 14px 16px; }
      #${CONTAINER_ID} .dq-table-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
      #${CONTAINER_ID} .dq-table-input { flex: 1 1 auto; min-width: 0; max-width: 420px; }
      #${CONTAINER_ID} .dq-table-name { color: #45526b; font-weight: 600; }
      #${CONTAINER_ID} .dq-section-head { display: flex; gap: 6px; align-items: center; font-weight: 600; font-size: 0.9em; margin: 14px 0 6px; }
      #${CONTAINER_ID} .dq-rows { display: flex; flex-direction: column; gap: 6px; }
      #${CONTAINER_ID} .dq-row { display: flex; gap: 8px; align-items: center; }
      #${CONTAINER_ID} .dq-select { font: inherit; padding: 5px 6px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; }
      #${CONTAINER_ID} .dq-field { flex: 0 1 220px; min-width: 0; }
      #${CONTAINER_ID} .dq-op { flex: 0 1 180px; min-width: 0; }
      #${CONTAINER_ID} .dq-agg { flex: 0 0 auto; }
      #${CONTAINER_ID} .dq-value { flex: 1 1 auto; min-width: 0; max-width: 280px; }
      #${CONTAINER_ID} .dq-novalue { flex: 1 1 auto; max-width: 280px; color: #aab2bf; }
      #${CONTAINER_ID} .dq-input { font: inherit; padding: 6px 8px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; }
      #${CONTAINER_ID} .dq-input:focus, #${CONTAINER_ID} .dq-select:focus { outline: none; border-color: #1c69e1; }
      #${CONTAINER_ID} .dq-btn { font: inherit; padding: 6px 12px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; white-space: nowrap; }
      #${CONTAINER_ID} .dq-btn:hover:not(:disabled) { border-color: #1c69e1; }
      #${CONTAINER_ID} .dq-btn:disabled { opacity: 0.5; cursor: default; }
      #${CONTAINER_ID} .dq-btn-primary { background: #1c69e1; border-color: #1c69e1; color: #fff; }
      #${CONTAINER_ID} .dq-btn-danger { background: #b3261e; border-color: #b3261e; color: #fff; }
      #${CONTAINER_ID} .dq-btn-small { align-self: flex-start; margin-top: 6px; padding: 4px 10px; font-size: 0.9em; }
      #${CONTAINER_ID} .dq-btn-icon { padding: 4px 8px; line-height: 1.2; }
      #${CONTAINER_ID} .dq-actions { display: flex; gap: 8px; align-items: center; margin-top: 16px; padding-top: 12px; border-top: 1px solid #e8edf5; flex-wrap: wrap; }
      #${CONTAINER_ID} .dq-name { display: block; width: 100%; max-width: 420px; box-sizing: border-box; margin-bottom: 10px; font-size: 1.15em; font-weight: 600; }
      #${CONTAINER_ID} .dq-name::placeholder { font-weight: 400; color: #aab2bf; }
      #${CONTAINER_ID} .dq-disclosure { display: flex; gap: 8px; align-items: baseline; width: 100%; margin-top: 14px; padding: 8px 10px; border: 1px solid #d5dae2; border-radius: 6px; background: #f6f8fb; color: inherit; font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
      #${CONTAINER_ID} .dq-disclosure:hover { border-color: #1c69e1; }
      #${CONTAINER_ID} .dq-caret { color: #788293; }
      #${CONTAINER_ID} .dq-disclosure-meta { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 400; font-size: 0.9em; color: #788293; }
      #${CONTAINER_ID} .dq-options { display: block; padding-left: 2px; }
      #${CONTAINER_ID} .dq-options[hidden] { display: none; }
      #${CONTAINER_ID} .dq-saved-tools { display: flex; gap: 6px; }
      #${CONTAINER_ID} .dq-saved-tools .dq-btn { flex: 1 1 auto; }
      #${CONTAINER_ID} .dq-import-head { margin: 0 0 6px; font-size: 1.1em; }
      #${CONTAINER_ID} .dq-import-text { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
      #${CONTAINER_ID} .dq-hint { color: #788293; margin: 6px 0; }
      #${CONTAINER_ID} .dq-result { margin-top: 18px; }
      #${CONTAINER_ID} .dq-summary { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
      #${CONTAINER_ID} .dq-count { font-weight: 600; }
      #${CONTAINER_ID} .dq-note { color: #788293; font-size: 0.85em; }
      #${CONTAINER_ID} .dq-scroll { overflow-x: auto; border: 1px solid #d5dae2; border-radius: 6px; }
      #${CONTAINER_ID} .dq-table { border-collapse: collapse; width: 100%; }
      #${CONTAINER_ID} .dq-table th, #${CONTAINER_ID} .dq-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e8edf5; vertical-align: top; }
      #${CONTAINER_ID} .dq-table th { background: #f6f8fb; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; color: #45526b; white-space: nowrap; }
      #${CONTAINER_ID} .dq-table tbody tr:hover { background: #f9fbfe; }
      #${CONTAINER_ID} .dq-table tr:last-child td { border-bottom: none; }
      #${CONTAINER_ID} .dq-cell { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-cell a { color: #1c69e1; }
      #${CONTAINER_ID} .dq-empty { color: #aab2bf; }
    `;

  // ── Tab lifecycle ───────────────────────────────────────────────────────────

  function mount(container) {
    ensureStyles(STYLE_ID, CSS);
    container.appendChild(
      el(
        "div",
        "dq-disclaimer",
        "Runs the same table API calls Tulip's own pages make, using this browser session's credentials — so you see exactly what your account can already see. Saved queries live in this browser's local storage for this Tulip instance; nothing is stored or sent anywhere by Tulbelt."
      )
    );
    container.appendChild(el("div", "dq-root"));

    // Reload from localStorage on every activation so saves from another tab on
    // this tenant show up after navigating away and back.
    const { store, error } = model.loadStore();
    state.store = store;
    state.storeError = error || "";
    state.importing = false;
    if (!state.query) state.query = model.emptyQuery(store.lastTableId);
    render();
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      window.__tulbeltPage.register({
        id: "data-queries",
        label: "Data Queries",
        containerId: CONTAINER_ID,
        order: 10,
        mount,
      });
    },
    onDisable() {
      window.__tulbeltPage.unregister("data-queries");
      removeStyles(STYLE_ID);
    },
  });
})();
