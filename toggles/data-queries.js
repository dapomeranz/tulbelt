// The Data Queries tab of the Tulbelt page (shell: toggles/tulbelt-page.js).
//
// Pick a table, build a filter/sort query against its columns, run it, and save
// it under a name. The requests are the same ones Tulip's own table page
// makes — /api/v3/w/<ws>/tables/<id>/records — issued from the tenant origin
// with the session's own credentials, so this shows exactly what the signed-in
// user is already allowed to see and nothing more.
//
// The table picker lists the workspace's tables (/tables) with the ones you
// opened recently on top (history-search.js's store). Both sources are
// optional: the field still takes a pasted id or table URL, which is all it
// took before the picker existed, so a refused list degrades to a shorter menu
// rather than a broken page. docs/data-queries-table-picker.md has the details.
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
// The page has two faces. A saved query opens in *use* mode — its name, its
// [Name] search boxes, and Export CSV — and the ✎ pencil swaps in the builder:
// name, table, filters, sort, columns, with Save and Cancel. A query that has
// not been saved yet lives in the builder until it is. docs/toggles.md has the
// walkthrough.
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
  const META_LABELS = {
    _sequenceNumber: "Seq",
    _createdAt: "Created",
    _updatedAt: "Updated",
    id: "ID",
  };
  const META_TYPES = {
    _sequenceNumber: "integer",
    _createdAt: "timestamp",
    _updatedAt: "timestamp",
    id: "string",
  };

  // Survives switching tabs and coming back.
  const state = {
    store: null,
    storeError: "",
    query: null,
    columns: [], // [{ name, label, dataType }] filterable/sortable targets
    columnTypes: {}, // name -> dataType, for operator narrowing and coercion
    // Field ids the table has archived. Records still carry their values, so
    // the grid and the CSV strike these keys; see archivedColumnsFromMeta().
    archivedColumns: new Set(),
    tableName: "",
    loading: false,
    error: "",
    hint: "",
    result: null,
    // Which page of the answer the grid is showing. Every change to the query
    // sends it back to 0; Prev/Next walk it.
    page: 0,
    // Why an auto-run held off — a half-built filter row, usually. A quiet note
    // under the builder, not the red banner a pressed button would have earned.
    pending: "",
    confirmDeleteId: null,
    savedFlash: "",
    exporting: false,
    exportCount: 0, // records fetched so far, for the in-progress readout
    cancelExport: false,
    // Two faces, not one page with a fold. A saved query opens in *use* mode —
    // its name, its search boxes, and Export — because the errand here is
    // grabbing rows, not editing; the pencil swaps in the builder. A query with
    // no id yet has nothing to use, so it is always in the builder (isEditing).
    editing: false,
    // The column chooser's popover. On state rather than in a closure because
    // every tick re-renders (the grid narrows live) and it has to come back open.
    columnsOpen: false,
    importing: false,
    // The picker's table list: null until the first load settles, then an
    // array (possibly empty). `tablesError` explains a short list; it is a
    // note beside the picker, never a banner — a missing list is a degraded
    // picker, not a failed page.
    tables: null,
    tablesError: "",
    tablesLoading: false,
    // What has been typed into the query's `[Name]` placeholders, keyed by
    // name. Lives as long as the tab does — switching away and back keeps a
    // search in place — but is never persisted: a saved query is a template,
    // not somebody's last search. Opening a different query clears it.
    inputs: {},
    // A header click's sort: { sortBy, sortDir } while one is in force, else
    // null for the query's own default. Same life as `inputs` — part of using
    // the query, never part of it — so it is not saved, and a different query
    // starts without it.
    viewSort: null,
  };

  // Set by the mounted table picker so an async list load can repopulate its
  // dropdown without a full render() — see loadTables().
  let refreshTableList = null;

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
    return apiJson(
      `/api/v3/w/${workspaceId()}/tables/${encodeURIComponent(tableId)}/records?${search}`,
    );
  }

  function fetchTableMeta(tableId) {
    return apiJson(`/api/v3/w/${workspaceId()}/tables/${encodeURIComponent(tableId)}`);
  }

  // The collection sibling of the two calls above, and it takes no query string
  // at all: `?limit=&offset=` earns a 400 ("extra param(s)"), so it is
  // unpaged — one call returns the workspace's tables. (The research note in
  // docs/data-queries-table-picker.md claimed 1–100 paging; that was wrong, and
  // the same 400 is what proved the session's borrowed credential is accepted
  // here — a refusal would have been a 401.)
  function fetchTables(wsId) {
    return apiJson(`/api/v3/w/${wsId}/tables`);
  }

  // ── Table list ──────────────────────────────────────────────────────────────

  // The picker's list comes from two independent places, either of which may be
  // empty: the workspace's own table list, and the tables this user has opened
  // in this browser. Neither is required — what you type still wins over both.

  const HISTORY_KEY = "tulbelt:history";

  /** MV3 content scripts usually expose `chrome.storage`; some builds use `browser`. */
  const storageLocal = () =>
    globalThis.chrome?.storage?.local ?? globalThis.browser?.storage?.local ?? null;

  // history-search.js records { kind, id, name, url, ts } per visited entity in
  // the same isolated world this file runs in, MRU-ordered. Filtered to tables
  // on this host it is exactly the id+name pairs the picker wants, at no
  // network cost — a recents list, not an enumeration, so it heads the list
  // rather than being it. Absent toggle, absent permission, and absent key all
  // land the same way: no recents.
  async function recentTables() {
    const local = storageLocal();
    if (!local) return [];
    try {
      const { [HISTORY_KEY]: stored = [] } = await local.get(HISTORY_KEY);
      if (!Array.isArray(stored)) return [];
      return stored
        .filter((e) => e && e.kind === "table" && e.id && e.name && sameInstance(e.url))
        .map((e) => ({ id: String(e.id), name: String(e.name), recent: true }));
    } catch (_) {
      return [];
    }
  }

  // Recents can outlive the instance they were recorded on — the store is one
  // list across every Tulip host this profile has visited.
  function sameInstance(url) {
    try {
      return new URL(url, location.href).host === location.host;
    } catch (_) {
      return false;
    }
  }

  // Archived is a soft delete in Tulip — a table gets `deletedAt`, a column
  // `hidden` — but these are private endpoints whose shapes we have
  // second-hand, so every spelling of "gone" counts. Nothing archived is ever
  // listed, offered as a filter target or column, or shown in the grid or the
  // CSV, whatever the payload calls it. docs/probes/archived-flags-probe.js
  // prints what a tenant actually sends.
  const isArchived = (item) =>
    Boolean(
      item.deleted ||
        item.deletedAt ||
        item.archived ||
        item.isArchived ||
        item.archivedAt ||
        item.hidden ||
        String(item.status || "").toLowerCase() === "archived",
    );

  // A private endpoint whose response shape we have second-hand: read the id
  // and label defensively and drop anything without an id, rather than let one
  // odd row poison the list. Archived tables come through flagged, not dropped,
  // so mergeTables() can also strike them from the recents.
  function tablesFromList(payload) {
    const items = Array.isArray(payload) ? payload : payload?.tables || payload?.items || [];
    if (!Array.isArray(items)) return [];
    return items
      .filter((t) => t)
      .map((t) => ({
        id: t.id || t.tableId || t._id,
        name: t.label || t.name || t.displayName || "",
        recent: false,
        archived: isArchived(t),
      }))
      .filter((t) => typeof t.id === "string" && t.id);
  }

  // One unpaged call per workspace. Today that is only the workspace this tab
  // is in; listing every workspace the account can reach is pending a way to
  // enumerate them (docs/probes/workspace-list-probe.js). When that lands, the
  // ids gathered here are what each table's `wsId` comes from — the record and
  // metadata calls have to target the table's *own* workspace, not the ambient
  // one, or a cross-workspace pick 404s.
  async function fetchAllTables() {
    const wsId = workspaceId();
    return tablesFromList(await fetchTables(wsId)).map((t) => ({ ...t, wsId }));
  }

  // Recents first, in their own MRU order, then everything else by name. The
  // list call is authoritative for names — a table renamed since you last
  // opened it should read as its current name — but a recent it doesn't
  // mention still stays in the list.
  // A recent's own url carries a workspace *slug*, not the number the API
  // wants, so a recent the list doesn't cover falls back to the ambient
  // workspace — the same assumption the page made before the picker existed.
  // An archived table is dropped from both halves: the list says so outright,
  // and a recent the list marks archived was opened before it went away.
  function mergeTables(recents, listed, ambientWsId = "") {
    const archived = new Set(listed.filter((t) => t.archived).map((t) => t.id));
    listed = listed.filter((t) => !t.archived);
    const byId = new Map(listed.map((t) => [t.id, t]));
    const recent = recents
      .filter((r) => !archived.has(r.id))
      .map((r) => ({
      ...r,
      name: byId.get(r.id)?.name || r.name,
      wsId: byId.get(r.id)?.wsId || r.wsId || ambientWsId,
      recent: true,
    }));
    const seen = new Set(recent.map((r) => r.id));
    const rest = listed
      .filter((t) => !seen.has(t.id))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
    return [...recent, ...rest];
  }

  // Called once per mount. A refused list is not an error the page reports —
  // it degrades to recents plus whatever you type, which is what the page did
  // before the picker existed.
  async function loadTables() {
    if (state.tablesLoading) return;
    state.tablesLoading = true;
    state.tablesError = "";

    const recents = await recentTables();
    let listed = [];
    try {
      listed = await fetchAllTables();
    } catch (err) {
      state.tablesError =
        err instanceof ApiError && (err.status === 401 || err.status === 403)
          ? "Couldn't list this workspace's tables — showing recents only. Paste an id or URL for anything else."
          : `Couldn't list this workspace's tables (${err.message}) — showing recents only.`;
    }

    state.tables = mergeTables(recents, listed, workspaceId());
    state.tablesLoading = false;
    // The list renames things outside the picker too — the saved-query rows go
    // from an id to a table name — so a full render is what we want. The one
    // exception is an open dropdown, which a render would tear down under
    // whoever is typing into it; that repaints in place and catches up on the
    // render that picking triggers.
    if (!refreshTableList || !refreshTableList()) render();
  }

  const tableNameFor = (id) => state.tables?.find((t) => t.id === id)?.name || "";

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
      .filter((c) => c && !isArchived(c))
      .map((c) => ({
        name: c.fieldId || c.name || c.id,
        label: c.label || c.displayName || c.name,
        dataType: c.dataType?.type || c.dataType || c.type || "",
      }))
      .filter((c) => typeof c.name === "string" && c.name);
  }

  // The other half of the metadata: fields that have been archived. Records
  // still carry values for them, so the grid has to know which keys to drop.
  function archivedColumnsFromMeta(meta) {
    const cols = meta?.columns || meta?.fields || [];
    if (!Array.isArray(cols)) return new Set();
    return new Set(
      cols
        .filter((c) => c && isArchived(c))
        .map((c) => c.fieldId || c.name || c.id)
        .filter((name) => typeof name === "string" && name),
    );
  }

  function labelFor(key) {
    const col = state.columns.find((c) => c.name === key);
    if (col?.label) return col.label;
    return META_LABELS[key] || labelFromFieldId(key);
  }

  // Records omit fields they have no value for, so with no column selection the
  // set is the union across the page. With one, the header *is* the selection:
  // a chosen column shows even when no row on this page has a value for it, so
  // the grid — and the CSV — carry the same columns from one page to the next.
  // A selected column the table no longer has is skipped rather than shown
  // empty; if nothing survives, the grid says so instead of guessing. Archived
  // fields never make a column either way — records still carry their values,
  // the metadata says they are gone, and the metadata wins.
  //
  // Either way the *order* is the table's own field order, the sequence the
  // metadata call hands back, which is how the columns read on Tulip's own
  // table page. Only fields the metadata didn't mention fall back to
  // first-seen order, and they sort after the ones it did. `id` leads, Tulip's
  // own record fields trail.
  function resultColumns(rows) {
    const seen = new Set();
    for (const row of rows) {
      for (const k of Object.keys(row)) if (!state.archivedColumns.has(k)) seen.add(k);
    }
    const order = new Map(state.columns.map((c, i) => [c.name, i]));
    const chosen = state.query.columns;
    const keys = chosen ? chosen.filter((k) => order.has(k) || seen.has(k)) : [...seen];
    const rank = (k) => (order.has(k) ? order.get(k) : Number.MAX_SAFE_INTEGER);
    const userKeys = keys
      .filter((k) => k !== "id" && !META_FIELDS.includes(k))
      .map((k, i) => ({ k, i }))
      .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i)
      .map((e) => e.k);
    return [
      ...(keys.includes("id") ? ["id"] : []),
      ...userKeys,
      ...META_FIELDS.filter((k) => keys.includes(k)),
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

  // The sort the request actually carries: a header click's while one is in
  // force, else the query's own default. Shared by the grid, paging and Export,
  // so the CSV is the view, not the configuration.
  const effectiveSort = () => (state.viewSort ? [state.viewSort] : state.query.sortOptions);

  const paramsFor = (offset) =>
    model.queryToParams(
      {
        ...state.query,
        sortOptions: effectiveSort(),
        columnTypes: state.columnTypes,
        inputs: state.inputs,
      },
      { offset },
    );

  // Every response shape Tulip has handed back for a records call.
  const recordsOf = (payload) => (Array.isArray(payload) ? payload : payload?.records || []);

  // Runs are superseded, not queued: typing into a filter value fires one per
  // pause, and only the last one's answer should ever reach the grid.
  let runSeq = 0;

  async function run({ reloadSchema = false, page = 0 } = {}) {
    const tableId = prepare();
    if (!tableId) return;
    const limit = model.normalizeLimit(state.query.limit);
    const offset = page * limit;
    const { search } = paramsFor(offset);

    const seq = (runSeq += 1);
    state.loading = true;
    state.page = page;
    // A schema reload means a different table — its rows have no business
    // sitting in the grid while this one loads.
    if (reloadSchema) state.result = null;
    state.pending = "";
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
      // A newer run started while this one was in flight; its answer wins.
      if (seq !== runSeq) return;
      if (needsSchema) {
        setColumns(columnsFromMeta(meta));
        state.archivedColumns = archivedColumnsFromMeta(meta);
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
        offset,
        // No total comes back with a page, so "there is more" is inferred the
        // same way Export infers it: a full page probably has another behind it.
        hasMore: rows.length >= limit,
      };
    } catch (err) {
      if (seq !== runSeq) return;
      state.error = explainFailure(err);
      state.result = null;
    } finally {
      if (seq === runSeq) {
        state.loading = false;
        render();
      }
    }
  }

  // ── Auto-run ────────────────────────────────────────────────────────────────

  // There is no Run button: every change to the query re-runs it, from page one.
  // A query whose answer you can't see isn't worth a click, and the answer is
  // the whole point of the page.
  //
  // A half-built row ("is" with no value typed yet) simply doesn't run — the
  // compile error becomes state.pending, a grey note beside the actions, and
  // the last good answer stays on screen until the row is finished.
  let autoRunTimer = null;

  function autoRun({ delay = 0 } = {}) {
    clearTimeout(autoRunTimer);
    autoRunTimer = setTimeout(fireAutoRun, delay);
  }

  function fireAutoRun() {
    autoRunTimer = null;
    // The tab can be gone by the time a debounced run comes due.
    if (!document.getElementById(CONTAINER_ID)) return;
    // Nothing to run against until a table's columns are in hand, and an export
    // walking the same query shouldn't have the grid racing it.
    if (!parseTableId(state.query.tableId) || state.columns.length === 0) return;
    if (state.exporting) return;

    const { error } = paramsFor(0);
    if (error) {
      state.pending = error;
      render();
      return;
    }
    run({ page: 0 });
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
      (state.tableName || tableId).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ||
      "table";
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
    // Deselect-all is a legitimate step toward picking a few, but not a file.
    if (Array.isArray(state.query.columns) && state.query.columns.length === 0) {
      state.error =
        "No columns selected — every one is unticked. Pick at least one in the editor.";
      render();
      return;
    }

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
        "text/csv;charset=utf-8",
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
    const { filters, error } = model.compileFilters(
      state.query.rows,
      state.columnTypes,
      state.inputs
    );
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
    // Save is also "done editing": the query goes back to its use face.
    state.editing = false;
    state.columnsOpen = false;
    render();
  }

  function loadSaved(id, flash = "", { keepView = false } = {}) {
    const saved = state.store.queries.find((q) => q.id === id);
    if (!saved) return;
    state.query = model.fromSaved(saved);
    state.result = null;
    state.page = 0;
    state.error = "";
    state.hint = "";
    state.savedFlash = "";
    state.confirmDeleteId = null;
    state.importing = false;
    state.editing = false;
    state.columnsOpen = false;
    // Another query's search terms and header sort have no meaning here.
    // (Cancelling an edit re-opens the same query, and keeps them.)
    if (!keepView) {
      state.inputs = {};
      state.viewSort = null;
    }
    // A different table means the columns in hand no longer describe it.
    state.columns = [];
    state.columnTypes = {};
    state.archivedColumns = new Set();
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
    state.page = 0;
    state.pending = "";
    state.error = "";
    state.savedFlash = "";
    state.confirmDeleteId = null;
    state.importing = false;
    state.editing = true;
    state.columnsOpen = false;
    state.inputs = {};
    state.viewSort = null;
    render();
    // The table is carried over, so a new query has an answer straight away:
    // that table, unfiltered.
    autoRun();
  }

  // Cancel in the builder: the saved version comes back and the page returns
  // to use mode. It is a plain re-open of the query, so a table switched
  // mid-edit reloads its own columns — the only things kept are the search
  // terms and header sort, which the edit never had any claim on.
  function cancelEdit() {
    if (!state.store.queries.some((q) => q.id === state.query.id)) return;
    loadSaved(state.query.id, "", { keepView: true });
  }

  // ── Grid sort ───────────────────────────────────────────────────────────────

  // The sort the grid is showing: a header click's while one is in force, else
  // the query's own default. Drives the header arrows.
  function activeSort() {
    if (state.viewSort) return state.viewSort;
    const [first] = state.query.sortOptions || [];
    return first ? { sortBy: first.sortBy, sortDir: first.sortDir } : null;
  }

  // A header click sorts ascending; a second click on the same header flips
  // it. Nothing about this touches the query — it goes back out over the API
  // as a fresh request with the same filters and search terms, from page one,
  // so it is the whole answer sorted and not just the page in hand.
  function sortBy(key) {
    const current = activeSort();
    const dir = current && current.sortBy === key && current.sortDir === "asc" ? "desc" : "asc";
    state.viewSort = { sortBy: key, sortDir: dir };
    run({ page: 0 });
  }

  function resetSort() {
    state.viewSort = null;
    run({ page: 0 });
  }

  // Unsaved queries have no "use" face — nothing to hand back — so they are
  // always in the builder, whatever `editing` says.
  const isEditing = () => state.editing || !state.query.id;

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
      select(
        "dq-select dq-field",
        [{ value: "", label: "Choose a field…" }, ...fieldOptions()],
        row.field,
        (v) => {
          row.field = v;
          // The new column may not offer the operator that was selected.
          const allowed = model.operatorsForType(state.columnTypes[v]);
          if (!allowed.some((o) => o.id === row.functionType)) row.functionType = allowed[0].id;
          render();
          autoRun();
        },
      ),
    );

    const ops = model.operatorsForType(state.columnTypes[row.field]);
    if (!row.functionType) row.functionType = ops[0].id;
    wrap.appendChild(
      select(
        "dq-select dq-op",
        ops.map((o) => ({ value: o.id, label: o.label })),
        row.functionType,
        (v) => {
          row.functionType = v;
          render();
          autoRun();
        },
      ),
    );

    const op = model.OPERATOR_BY_ID.get(row.functionType);
    if (op && op.arity !== 0) {
      const input = el("input", "dq-input dq-value");
      input.type = "text";
      input.value = row.value ?? "";
      input.placeholder = op.arity === "list" ? "a, b, c — or [Name]" : "value or [Name]";
      // Advertise runtime inputs here, because this box is the only place they
      // can be written and nothing else on the page would hint at them.
      input.title =
        (op.arity === "list" ? "Comma-separated; sent as a list.\n" : "") +
        "Put [Name] in the value to turn it into a search box above the grid — " +
        "leaving that box empty drops this filter instead of matching on nothing.";
      // Deliberately no re-render on input — that would drop the caret. The
      // auto-run does re-render when it lands, so the field carries a key that
      // render() uses to put the caret back exactly where it was.
      input.dataset.dqFocus = `filter-value-${index}`;
      input.addEventListener("input", () => {
        row.value = input.value;
        // Long enough that a run isn't fired per keystroke, short enough that
        // stopping to look at the grid doesn't feel like waiting.
        autoRun({ delay: 450 });
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
      autoRun();
    });
    wrap.appendChild(remove);
    return wrap;
  }

  // Editing the default sort also lifts any header sort, so the grid shows
  // what was just chosen rather than a click from earlier.
  function renderSortRow(sort, index) {
    const wrap = el("div", "dq-row");
    wrap.appendChild(
      select("dq-select dq-field", fieldOptions(), sort.sortBy, (v) => {
        sort.sortBy = v;
        state.viewSort = null;
        autoRun();
      }),
    );
    wrap.appendChild(
      select(
        "dq-select dq-op",
        [
          { value: "desc", label: "newest / Z→A" },
          { value: "asc", label: "oldest / A→Z" },
        ],
        sort.sortDir,
        (v) => {
          sort.sortDir = v;
          state.viewSort = null;
          autoRun();
        },
      ),
    );
    const remove = el("button", "dq-btn dq-btn-icon", "×");
    remove.type = "button";
    remove.title = "Remove this sort";
    remove.addEventListener("click", () => {
      state.query.sortOptions.splice(index, 1);
      state.viewSort = null;
      render();
      autoRun();
    });
    wrap.appendChild(remove);
    return wrap;
  }

  // A one-line read of the query, for the use panel's subtitle and the saved
  // list: what it filters on, how it sorts, and — only when narrowed — which
  // columns it keeps.
  function optionsSummary() {
    const filters = state.query.rows.filter((r) => r.field).length;
    const sorts = state.query.sortOptions
      .map((o) => `${labelFor(o.sortBy)} ${o.sortDir === "asc" ? "↑" : "↓"}`)
      .join(", ");
    const parts = [
      filters === 0 ? "no filters" : `${filters} filter${filters === 1 ? "" : "s"}`,
      sorts ? `default sort ${sorts}` : "no default sort",
    ];
    const chosen = state.query.columns;
    if (chosen) {
      const total = state.columns.length;
      const n = total ? chosen.filter((k) => k in state.columnTypes).length : chosen.length;
      parts.push(total ? `${n} of ${total} columns` : `${n} column${n === 1 ? "" : "s"}`);
    }
    return parts.join(" · ");
  }

  // ── Table picker ────────────────────────────────────────────────────────────

  // A combobox over the table list that still behaves like the plain text field
  // it replaces: the input holds the table *id*, so pasting an id or a table URL
  // works exactly as it did and `state.query.tableId` stays the single truth.
  // Typing filters the list by name or id; the resolved name sits beside it.
  //
  // render() rebuilds the whole root, so this owns its open/highlight state in
  // closure variables and never calls render() while the dropdown is open —
  // the same discipline the name and filter-value inputs use to keep the caret.
  function renderTablePicker() {
    const row = el("div", "dq-table-row");
    const combo = el("div", "dq-combo");

    // The table this picker was rendered against. A column selection only
    // means anything for the table it was made on, so switching tables drops
    // it; re-loading the same table keeps it.
    const before = parseTableId(state.query.tableId);
    const load = () => {
      if (parseTableId(state.query.tableId) !== before) {
        state.query.columns = null;
        state.columnsOpen = false;
        state.viewSort = null;
      }
      run({ reloadSchema: true });
    };

    const input = el("input", "dq-input dq-table-input");
    input.type = "text";
    input.placeholder = "Pick a table, or paste an id / URL";
    input.value = state.query.tableId;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-label", "Table");

    const panel = el("div", "dq-combo-panel");
    panel.hidden = true;
    panel.setAttribute("role", "listbox");

    const nameSpan = el("span", "dq-table-name");
    const showName = () => {
      nameSpan.textContent = state.tableName || tableNameFor(state.query.tableId) || "";
    };

    let shown = []; // rows currently listed, in display order
    let active = -1; // highlighted index into `shown`

    const isOpen = () => !panel.hidden;

    function close() {
      panel.hidden = true;
      active = -1;
      input.setAttribute("aria-expanded", "false");
    }

    // A *picked* id would otherwise filter the list down to the one table you
    // already have, so text that exactly matches an id lists everything.
    function matching() {
      const all = state.tables || [];
      const q = input.value.trim().toLowerCase();
      if (!q || all.some((t) => t.id.toLowerCase() === q)) return all;
      return all.filter((t) => t.name.toLowerCase().includes(q) || t.id.toLowerCase().includes(q));
    }

    function highlight() {
      const opts = panel.querySelectorAll(".dq-combo-opt");
      opts.forEach((o, i) => o.classList.toggle("dq-combo-active", i === active));
      if (active >= 0 && opts[active]) opts[active].scrollIntoView({ block: "nearest" });
    }

    function pick(table) {
      input.value = table.id;
      state.query.tableId = table.id;
      close();
      // Picking is the whole gesture — nobody picks a table and then wants to
      // press Load.
      load();
    }

    function fill() {
      panel.textContent = "";
      shown = matching();
      if (active >= shown.length) active = shown.length - 1;

      if (!shown.length) {
        panel.appendChild(
          el(
            "p",
            "dq-combo-empty",
            state.tablesLoading
              ? "Loading tables…"
              : state.tables?.length
                ? "No table matches that."
                : "No tables to list — paste an id or URL.",
          ),
        );
      }

      shown.forEach((t, i) => {
        const opt = el("button", "dq-combo-opt");
        opt.type = "button";
        opt.setAttribute("role", "option");
        if (t.id === state.query.tableId) opt.classList.add("dq-combo-current");
        opt.appendChild(el("span", "dq-combo-name", t.name || t.id));
        opt.appendChild(el("span", "dq-combo-tag", t.recent ? "recent" : t.id));
        // mousedown, not click: the input's blur would tear the panel down
        // before a click ever landed.
        opt.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(t);
        });
        opt.addEventListener("mouseenter", () => {
          active = i;
          highlight();
        });
        panel.appendChild(opt);
      });

      const n = state.tables?.length || 0;
      const foot = el(
        "div",
        "dq-combo-foot",
        state.tablesError || `${n} table${n === 1 ? "" : "s"} · or paste an id / URL`,
      );
      if (state.tablesError) foot.classList.add("dq-combo-foot-warn");
      panel.appendChild(foot);

      highlight();
    }

    function open() {
      panel.hidden = false;
      input.setAttribute("aria-expanded", "true");
      fill();
    }

    // No render() on input — that would rebuild the field and drop the caret.
    input.addEventListener("input", () => {
      state.query.tableId = input.value;
      active = -1;
      showName();
      open();
    });
    input.addEventListener("focus", () => open());
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen()) return open();
        if (!shown.length) return;
        active =
          e.key === "ArrowDown"
            ? (active + 1) % shown.length
            : (active <= 0 ? shown.length : active) - 1;
        highlight();
      } else if (e.key === "Enter") {
        e.preventDefault();
        // A highlighted row wins; otherwise load whatever is typed, which is
        // what Enter did before the picker existed.
        if (isOpen() && active >= 0 && shown[active]) return pick(shown[active]);
        close();
        load();
      } else if (e.key === "Escape" && isOpen()) {
        // Don't let it bubble — the page shell may act on Escape too.
        e.stopPropagation();
        close();
      }
    });

    const caret = el("button", "dq-combo-caret", "▾");
    caret.type = "button";
    caret.tabIndex = -1;
    caret.title = "Show tables";
    caret.setAttribute("aria-label", "Show tables");
    caret.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (isOpen()) return close();
      input.focus();
      open();
    });

    // Capture phase, so a click anywhere else closes even if that handler stops
    // propagation. The listener outlives no render: the node it guards is gone
    // after one, and that is when it unhooks itself.
    const onDocDown = (e) => {
      if (!combo.isConnected) return document.removeEventListener("mousedown", onDocDown, true);
      if (!combo.contains(e.target)) close();
    };
    document.addEventListener("mousedown", onDocDown, true);

    // Lets an async list load repaint this picker in place instead of forcing a
    // render that would close the dropdown under whoever is typing into it.
    // Returns whether it handled the update; false means "just render()".
    refreshTableList = () => {
      if (!combo.isConnected) {
        refreshTableList = null;
        return false;
      }
      if (!isOpen()) return false;
      showName();
      fill();
      return true;
    };

    const loadBtn = el("button", "dq-btn", "Load table");
    loadBtn.type = "button";
    loadBtn.title = "Fetch this table's columns, then run the query";
    loadBtn.addEventListener("click", () => {
      close();
      load();
    });

    showName();
    combo.appendChild(input);
    combo.appendChild(caret);
    combo.appendChild(panel);
    row.appendChild(combo);
    row.appendChild(loadBtn);
    row.appendChild(nameSpan);
    return row;
  }

  function renderBuilder() {
    const box = el("section", "dq-panel dq-builder");

    // Says which face of the page this is — the accent bar does the rest.
    const head = el("div", "dq-builder-head");
    head.appendChild(el("span", "dq-eyebrow", state.query.id ? "Editing query" : "New query"));
    if (state.query.id) {
      head.appendChild(
        el(
          "span",
          "dq-note",
          "The grid follows every change; Save keeps them, Cancel puts the saved version back.",
        ),
      );
    }
    box.appendChild(head);

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

    // Which table.
    box.appendChild(renderTablePicker());

    if (state.columns.length === 0) {
      box.appendChild(el("p", "dq-hint", "Load a table to build a query against its columns."));
      return box;
    }

    // Filters.
    const filterHead = el("div", "dq-section-head");
    filterHead.appendChild(el("span", null, "Match"));
    filterHead.appendChild(
      select(
        "dq-select dq-agg",
        [
          { value: "all", label: "all" },
          { value: "any", label: "any" },
        ],
        state.query.filterAggregator,
        (v) => {
          state.query.filterAggregator = v;
          autoRun();
        },
      ),
    );
    filterHead.appendChild(el("span", null, "of these filters:"));
    box.appendChild(filterHead);

    const filters = el("div", "dq-rows");
    state.query.rows.forEach((row, i) => filters.appendChild(renderFilterRow(row, i)));
    if (state.query.rows.length === 0) {
      filters.appendChild(el("p", "dq-hint", "No filters — every record is returned."));
    }
    box.appendChild(filters);

    const addFilter = el("button", "dq-btn dq-btn-small", "+ Add filter");
    addFilter.type = "button";
    addFilter.addEventListener("click", () => {
      state.query.rows.push({ field: "", functionType: "", value: "" });
      render();
    });
    box.appendChild(addFilter);

    // Default sort — the order the query opens in. A header click on the grid
    // overrides it for the moment without touching it.
    box.appendChild(el("div", "dq-section-head", "Default sort:"));
    const sorts = el("div", "dq-rows");
    state.query.sortOptions.forEach((s, i) => sorts.appendChild(renderSortRow(s, i)));
    if (state.query.sortOptions.length === 0) {
      sorts.appendChild(
        el("p", "dq-hint", "No default sort — Tulip's own order. Click a column header to sort the grid."),
      );
    }
    box.appendChild(sorts);

    const addSort = el("button", "dq-btn dq-btn-small", "+ Add sort");
    addSort.type = "button";
    addSort.addEventListener("click", () => {
      state.query.sortOptions.push({ sortBy: state.columns[0].name, sortDir: "desc" });
      state.viewSort = null;
      render();
      autoRun();
    });
    box.appendChild(addSort);

    // Columns.
    box.appendChild(el("div", "dq-section-head", "Columns:"));
    box.appendChild(renderColumnChooser());

    // Actions. Save leads: it is what the builder is for; Export lives with
    // the pager above the grid, in both faces of the page.
    const actions = el("div", "dq-actions");

    const saveBtn = el(
      "button",
      "dq-btn dq-btn-primary dq-btn-save",
      state.query.id ? "Save" : "Save query",
    );
    saveBtn.type = "button";
    saveBtn.disabled = !state.query.name.trim();
    saveBtn.title = state.query.name.trim()
      ? "Save and go back to using the query"
      : "Name the query up top to save it";
    saveBtn.addEventListener("click", saveCurrent);
    actions.appendChild(saveBtn);

    if (state.query.id) {
      const cancelBtn = el("button", "dq-btn", "Cancel");
      cancelBtn.type = "button";
      cancelBtn.title = "Drop these changes and go back to the saved version";
      cancelBtn.addEventListener("click", cancelEdit);
      actions.appendChild(cancelBtn);
    }

    const note = renderRunNote();
    if (note) actions.appendChild(note);

    box.appendChild(actions);
    return box;
  }

  // Export CSV plus, mid-export, the running count and a Cancel. Sits in the
  // pager beside Prev, so the whole answer is one step from the page of it you
  // are looking at — in both faces of the page.
  function renderExportControls() {
    const nodes = [];
    const exportBtn = el(
      "button",
      "dq-btn dq-btn-primary dq-btn-page",
      state.exporting ? "Exporting…" : "Export CSV",
    );
    exportBtn.type = "button";
    exportBtn.title = "Page through every matching record and download them all as a CSV";
    exportBtn.disabled = state.loading || state.exporting;
    exportBtn.addEventListener("click", exportCsv);
    nodes.push(exportBtn);

    if (state.exporting) {
      nodes.push(el("span", "dq-note", `${state.exportCount} fetched…`));
      const cancelBtn = el("button", "dq-btn dq-btn-small", "Cancel");
      cancelBtn.type = "button";
      // Takes effect between pages; the request already in flight still lands.
      cancelBtn.addEventListener("click", () => {
        state.cancelExport = true;
      });
      nodes.push(cancelBtn);
    }
    return nodes;
  }

  // Why the grid isn't already showing this query's answer.
  function renderRunNote() {
    if (state.loading) return el("span", "dq-note", "Running…");
    if (state.pending) return el("span", "dq-note", state.pending);
    return null;
  }

  // ── Column chooser ──────────────────────────────────────────────────────────

  // Which columns the grid and the CSV carry. Purely client-side: the records
  // call has no projection parameter, so every field still comes down the wire
  // and this only decides what is shown and exported. `null` means everything,
  // and a fully-ticked list normalises back to it — so a query saved with every
  // column ticked keeps showing columns added to the table later, rather than
  // freezing the list it saw at save time. An empty list is honoured as "none",
  // which the grid reports rather than quietly widening.
  const knownColumnNames = () => state.columns.map((c) => c.name);

  function setColumnSelection(names) {
    const all = knownColumnNames();
    const picked = new Set(names);
    state.query.columns = all.every((n) => picked.has(n))
      ? null
      : all.filter((n) => picked.has(n));
    // The grid narrows straight away — the rows are the same, only the header
    // changes, so there is nothing to fetch.
    if (state.result) state.result.columns = resultColumns(state.result.rows);
    render();
  }

  function renderColumnChooser() {
    const wrap = el("div", "dq-cols");
    const all = knownColumnNames();
    const chosen = state.query.columns;
    const ticked = new Set(chosen ? chosen.filter((n) => all.includes(n)) : all);

    const btn = el("button", "dq-btn dq-cols-btn");
    btn.type = "button";
    btn.setAttribute("aria-haspopup", "true");
    btn.setAttribute("aria-expanded", String(state.columnsOpen));
    const caret = el("span", "dq-caret", state.columnsOpen ? "▾" : "▸");
    btn.appendChild(caret);
    btn.appendChild(
      el(
        "span",
        null,
        chosen ? `${ticked.size} of ${all.length} columns` : `All ${all.length} columns`,
      ),
    );
    btn.title = "Choose which columns the grid shows and the CSV includes";
    btn.addEventListener("click", () => {
      state.columnsOpen = !state.columnsOpen;
      render();
    });
    wrap.appendChild(btn);

    if (!state.columnsOpen) return wrap;

    const panel = el("div", "dq-cols-panel");
    panel.setAttribute("role", "group");
    panel.setAttribute("aria-label", "Columns");

    // Closing without a render, for the paths where a render would pull the
    // thing being clicked out from under the click (outside mousedown) or drop
    // the keyboard focus somewhere unhelpful (Escape).
    const closeQuietly = () => {
      state.columnsOpen = false;
      panel.remove();
      btn.setAttribute("aria-expanded", "false");
      caret.textContent = "▸";
    };

    const tools = el("div", "dq-cols-tools");
    const selectAll = el("button", "dq-btn dq-btn-small", "Select all");
    selectAll.type = "button";
    selectAll.addEventListener("click", () => setColumnSelection(all));
    const clearAll = el("button", "dq-btn dq-btn-small", "Deselect all");
    clearAll.type = "button";
    clearAll.addEventListener("click", () => setColumnSelection([]));
    tools.appendChild(selectAll);
    tools.appendChild(clearAll);
    panel.appendChild(tools);

    const list = el("div", "dq-cols-list");
    for (const col of state.columns) {
      const row = el("label", "dq-cols-opt");
      const cb = el("input");
      cb.type = "checkbox";
      cb.checked = ticked.has(col.name);
      // Each tick re-renders; this key puts the focus back on the same box so
      // Space, Tab, Space walks the list.
      cb.dataset.dqFocus = `col:${col.name}`;
      cb.addEventListener("change", () => {
        const next = new Set(ticked);
        if (cb.checked) next.add(col.name);
        else next.delete(col.name);
        setColumnSelection([...next]);
      });
      row.appendChild(cb);
      row.appendChild(el("span", "dq-cols-label", col.label || col.name));
      if (col.label && col.label !== col.name) row.appendChild(el("span", "dq-cols-tag", col.name));
      list.appendChild(row);
    }
    panel.appendChild(list);

    const foot = el("div", "dq-cols-foot");
    foot.appendChild(el("span", null, `${ticked.size} of ${all.length} selected`));
    const done = el("button", "dq-btn dq-btn-small", "Done");
    done.type = "button";
    done.addEventListener("click", () => {
      state.columnsOpen = false;
      render();
    });
    foot.appendChild(done);
    panel.appendChild(foot);

    panel.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      // Don't let it bubble — the page shell may act on Escape too.
      e.stopPropagation();
      closeQuietly();
      btn.focus();
    });

    // Same outside-click discipline as the table picker: capture phase, and
    // the listener unhooks itself once the node it guards has been rebuilt.
    const onDocDown = (e) => {
      if (!wrap.isConnected) return document.removeEventListener("mousedown", onDocDown, true);
      if (!wrap.contains(e.target)) closeQuietly();
    };
    document.addEventListener("mousedown", onDocDown, true);

    wrap.appendChild(panel);
    return wrap;
  }

  // ── Use panel ───────────────────────────────────────────────────────────────

  // The face a saved query opens in: what it is and its search boxes; Export
  // is up by the pager. Nothing here changes the query — that is what the
  // pencil beside the name is for — so the table, filters, sort and columns
  // read as a subtitle, not as fields.
  function renderUsePanel() {
    const box = el("section", "dq-panel dq-use");

    const titleRow = el("div", "dq-use-title-row");
    titleRow.appendChild(el("h2", "dq-use-name", state.query.name || "Untitled query"));
    const edit = el("button", "dq-btn dq-btn-icon dq-edit", "✎");
    edit.type = "button";
    edit.title = "Edit this query — its table, filters, sort and columns";
    edit.setAttribute("aria-label", "Edit query");
    edit.addEventListener("click", () => {
      state.editing = true;
      state.savedFlash = "";
      render();
    });
    titleRow.appendChild(edit);
    const note = renderRunNote();
    if (note) titleRow.appendChild(note);
    box.appendChild(titleRow);

    const where = state.tableName || tableNameFor(state.query.tableId) || state.query.tableId;
    const meta = el("p", "dq-use-meta", `${where} · ${optionsSummary()}`);
    meta.title = state.query.tableId;
    box.appendChild(meta);

    const inputBar = renderInputBar();
    if (inputBar) box.appendChild(inputBar);
    return box;
  }

  // ── Search inputs ───────────────────────────────────────────────────────────

  // The boxes behind a query's `[Name]` placeholders. This is what turns a
  // saved query into a search tool, so in use mode they are the controls you
  // see — inside the use panel, above the grid — and in the builder they sit
  // underneath it so a placeholder can be tried as it is typed.
  //
  // A blank box means "don't narrow by this" rather than "match empty", so the
  // query runs with that filter left out entirely; all blank is the whole
  // table. That rule lives in the model (resolveValue), not here.
  const queryInputs = () => model.parseInputs(state.query?.rows || []);

  const inputValue = (name) => state.inputs[name] ?? "";

  function renderInputBar() {
    const inputs = queryInputs();
    if (inputs.length === 0) return null;

    const bar = el("section", "dq-inputs");
    const head = el("div", "dq-inputs-head");
    head.appendChild(el("span", "dq-inputs-title", inputs.length === 1 ? "Search" : "Search by"));

    const filled = inputs.filter((i) => inputValue(i.name).trim() !== "");
    if (filled.length) {
      const clear = el("button", "dq-btn dq-btn-small", "Clear");
      clear.type = "button";
      clear.title = "Empty every box and show everything";
      clear.addEventListener("click", () => {
        state.inputs = {};
        render();
        autoRun();
      });
      head.appendChild(clear);
    }
    bar.appendChild(head);

    const fields = el("div", "dq-inputs-row");
    for (const { name } of inputs) {
      const wrap = el("label", "dq-input-field");
      wrap.appendChild(el("span", "dq-input-label", name));

      const box = el("input", "dq-input dq-input-box");
      box.type = "text";
      box.value = inputValue(name);
      box.spellcheck = false;
      box.placeholder = "anything";
      // The key focusSnapshot()/restoreFocus() uses to put the caret back
      // after the re-render each keystroke triggers.
      box.dataset.dqFocus = `input:${name}`;
      if (inputValue(name).trim() === "") wrap.classList.add("dq-input-blank");

      box.addEventListener("input", () => {
        state.inputs[name] = box.value;
        // Same debounce the filter-value boxes use: one run per pause, not one
        // per keystroke.
        autoRun({ delay: 450 });
        render();
      });
      box.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        // Don't make someone wait out the debounce they just decided to skip.
        e.preventDefault();
        state.inputs[name] = box.value;
        autoRun();
      });

      wrap.appendChild(box);
      fields.appendChild(wrap);
    }
    bar.appendChild(fields);
    return bar;
  }

  // One line under the boxes saying what is actually narrowing the result, so
  // "everything" never reads as a bug.
  function inputSummary() {
    const inputs = queryInputs();
    if (inputs.length === 0) return "";
    const active = inputs.filter((i) => inputValue(i.name).trim() !== "").map((i) => i.name);
    const blank = inputs.filter((i) => inputValue(i.name).trim() === "").map((i) => i.name);
    if (active.length === 0) return "Showing everything — fill a box to narrow it.";
    const parts = [`Filtered by ${active.join(", ")}`];
    if (blank.length) parts.push(`${blank.join(", ")} ignored (blank)`);
    return `${parts.join(" · ")}.`;
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
      },
    );
  }

  function renderImportForm() {
    const form = el("section", "dq-panel");
    form.appendChild(el("h2", "dq-import-head", "Import queries"));
    form.appendChild(
      el(
        "p",
        "dq-hint",
        "Paste an export from another Tulbelt user. Imported queries are added alongside your existing ones — a name already in use gets a number.",
      ),
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
      panel.appendChild(
        el("p", "dq-hint", "No saved queries yet. Build one, name it, and hit Save."),
      );
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
      // The table's name once the list is in hand; its id until then, and for
      // anything the list doesn't cover.
      const where = tableNameFor(q.tableId) || q.tableId;
      const meta = el(
        "span",
        "dq-saved-meta",
        `${where} · ${count} filter${count === 1 ? "" : "s"}`,
      );
      meta.title = q.tableId;
      open.appendChild(meta);
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

  // Export CSV and Prev/Next over offset pages, sitting with the record count
  // above the grid: the page you are on, and the way to get all of them.
  // No page count to show: a records call returns a page and no total, so the
  // only thing known about what's ahead is whether this page came back full.
  function renderPager(result) {
    const pager = el("div", "dq-pager");
    const busy = state.loading || state.exporting;
    const limit = model.normalizeLimit(state.query.limit);
    // The page these rows came from, which during a fetch is not yet the page
    // state.page is heading for — the label has to agree with the grid under it.
    const page = Math.floor(result.offset / limit);

    for (const node of renderExportControls()) pager.appendChild(node);

    const prev = el("button", "dq-btn dq-btn-page", "‹ Prev");
    prev.type = "button";
    prev.disabled = page === 0 || busy;
    prev.title = "Previous page";
    prev.addEventListener("click", () => run({ page: page - 1 }));
    pager.appendChild(prev);

    pager.appendChild(el("span", "dq-page-label", `Page ${page + 1}`));

    const next = el("button", "dq-btn dq-btn-page", "Next ›");
    next.type = "button";
    next.disabled = !result.hasMore || busy;
    next.title = result.hasMore ? "Next page" : "This is the last page";
    next.addEventListener("click", () => run({ page: page + 1 }));
    pager.appendChild(next);

    pager.appendChild(
      el(
        "span",
        "dq-note",
        state.loading ? "Fetching…" : `${limit} per page`,
      ),
    );
    return pager;
  }

  function renderResult(result) {
    const wrap = el("div", "dq-result");

    const summary = el("div", "dq-summary");
    const count = result.rows.length;
    summary.appendChild(
      el(
        "span",
        "dq-count",
        count === 0
          ? result.offset
            ? "No records on this page"
            : "No records"
          : `Records ${result.offset + 1}–${result.offset + count}`,
      ),
    );
    summary.appendChild(renderPager(result));
    // A header sort is in force: say so, and offer the way back. The default
    // sort needs no note — the header arrow already shows it.
    if (state.viewSort) {
      const note = el("span", "dq-note dq-sort-note");
      note.appendChild(
        document.createTextNode(
          `Sorted by ${labelFor(state.viewSort.sortBy)} ${state.viewSort.sortDir === "asc" ? "↑" : "↓"} · `,
        ),
      );
      const reset = el("button", "dq-link", "back to the default sort");
      reset.type = "button";
      reset.addEventListener("click", resetSort);
      note.appendChild(reset);
      summary.appendChild(note);
    }
    wrap.appendChild(summary);

    const inputNote = inputSummary();
    if (inputNote) wrap.appendChild(el("p", "dq-input-summary", inputNote));

    if (count === 0) {
      wrap.appendChild(
        el(
          "p",
          "dq-hint",
          result.offset
            ? "Past the end of the answer — step back a page."
            : "Nothing matched. Loosen a filter, or switch Match all to Match any.",
        ),
      );
      return wrap;
    }

    if (result.columns.length === 0) {
      wrap.appendChild(
        el(
          "p",
          "dq-hint",
          "No columns selected — every one is unticked. Edit the query and pick some.",
        ),
      );
      return wrap;
    }

    const scroller = el("div", "dq-scroll");
    const table = el("table", "dq-table");
    const thead = el("thead");
    const headRow = el("tr");
    // Every header sorts: Tulip's records call takes any field as sortBy, so
    // there is no column to leave inert.
    const active = activeSort();
    for (const col of result.columns) {
      const th = el("th", "dq-sortable");
      th.appendChild(el("span", null, col.label));
      const sorted = active && active.sortBy === col.key;
      if (sorted) {
        th.classList.add("dq-sorted");
        th.appendChild(el("span", "dq-sort-ind", active.sortDir === "asc" ? "↑" : "↓"));
        th.setAttribute("aria-sort", active.sortDir === "asc" ? "ascending" : "descending");
      }
      // The raw field id is what you need when writing a query against it.
      th.title = col.label !== col.key ? `${col.key} — click to sort` : "Click to sort";
      th.tabIndex = 0;
      th.setAttribute("role", "button");
      th.addEventListener("click", () => sortBy(col.key));
      th.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        sortBy(col.key);
      });
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

  // An auto-run re-renders while you are still typing into a filter value, so
  // the rebuild has to put the caret back. Inputs that need to survive a render
  // carry a stable `data-dq-focus` key; everything else is rebuilt cold.
  function focusSnapshot() {
    const node = document.activeElement;
    const key = node && node.dataset ? node.dataset.dqFocus : "";
    if (!key) return null;
    return { key, start: node.selectionStart, end: node.selectionEnd };
  }

  function restoreFocus(snap) {
    if (!snap) return;
    const node = document.querySelector(`#${CONTAINER_ID} [data-dq-focus="${snap.key}"]`);
    if (!node) return;
    node.focus();
    if (snap.start != null) {
      try {
        node.setSelectionRange(snap.start, snap.end);
      } catch (_) {}
    }
  }

  function render() {
    const root = document.querySelector(`#${CONTAINER_ID} .dq-root`);
    if (!root) return;
    const focus = focusSnapshot();
    root.textContent = "";

    if (state.storeError) root.appendChild(el("div", "dq-banner", state.storeError));

    const layout = el("div", "dq-layout");
    layout.appendChild(renderSaved());

    const main = el("div", "dq-main");
    if (state.importing) {
      main.appendChild(renderImportForm());
      layout.appendChild(main);
      root.appendChild(layout);
      restoreFocus(focus);
      return;
    }
    if (isEditing()) {
      main.appendChild(renderBuilder());
      // The search boxes stay under the builder while editing, so a [Name]
      // placeholder can be tried the moment it is typed.
      const inputBar = renderInputBar();
      if (inputBar) main.appendChild(inputBar);
    } else {
      main.appendChild(renderUsePanel());
    }
    if (state.error) main.appendChild(el("div", "dq-banner", state.error));
    if (state.hint) main.appendChild(el("div", "dq-note-banner", state.hint));
    if (state.savedFlash) main.appendChild(el("div", "dq-flash", state.savedFlash));

    // The grid stays put while the next page is fetched — paging shouldn't make
    // the thing you are reading disappear and come back.
    if (state.result) main.appendChild(renderResult(state.result));
    else if (state.loading) main.appendChild(el("p", "dq-hint", "Fetching records…"));

    layout.appendChild(main);
    root.appendChild(layout);
    restoreFocus(focus);
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
      #${CONTAINER_ID} .dq-panel { border: 1px solid #d5dae2; border-radius: 6px; padding: 14px 16px; background: #fff; }
      /* The two faces of the page. Use is a plain card; the builder wears an
         accent bar and a tint so that being in it is never a surprise. */
      #${CONTAINER_ID} .dq-builder { border-color: #c9dcf7; border-left: 4px solid #1c69e1; background: #fbfcfe; }
      #${CONTAINER_ID} .dq-builder-head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; margin-bottom: 10px; }
      #${CONTAINER_ID} .dq-eyebrow { font-size: 0.75em; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: #1c69e1; }
      #${CONTAINER_ID} .dq-use-title-row { display: flex; gap: 10px; align-items: center; min-width: 0; }
      #${CONTAINER_ID} .dq-use-name { margin: 0; min-width: 0; font-size: 1.25em; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-use-meta { margin: 4px 0 0; color: #788293; font-size: 0.9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-edit { flex: 0 0 auto; font-size: 1.1em; padding: 3px 8px; line-height: 1; }
      #${CONTAINER_ID} .dq-pager .dq-btn-small { margin-top: 0; padding: 3px 10px; }
      #${CONTAINER_ID} .dq-pager .dq-btn-primary { margin-right: 6px; }
      #${CONTAINER_ID} .dq-caret { color: #788293; }
      #${CONTAINER_ID} .dq-cols { position: relative; display: inline-block; }
      #${CONTAINER_ID} .dq-cols-btn { display: inline-flex; gap: 8px; align-items: baseline; }
      #${CONTAINER_ID} .dq-cols-panel { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; width: 340px; max-height: 340px; display: flex; flex-direction: column; background: #fff; border: 1px solid #d5dae2; border-radius: 6px; box-shadow: 0 6px 20px rgba(23, 33, 51, 0.14); }
      #${CONTAINER_ID} .dq-cols-tools { display: flex; gap: 6px; padding: 8px 10px; border-bottom: 1px solid #e8edf5; }
      #${CONTAINER_ID} .dq-cols-tools .dq-btn-small, #${CONTAINER_ID} .dq-cols-foot .dq-btn-small { margin-top: 0; }
      #${CONTAINER_ID} .dq-cols-list { overflow-y: auto; padding: 4px 0; }
      #${CONTAINER_ID} .dq-cols-opt { display: flex; gap: 8px; align-items: center; padding: 5px 10px; cursor: pointer; }
      #${CONTAINER_ID} .dq-cols-opt:hover { background: #f6f8fb; }
      #${CONTAINER_ID} .dq-cols-opt input { margin: 0; flex: 0 0 auto; }
      #${CONTAINER_ID} .dq-cols-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-cols-tag { flex: 0 0 auto; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aab2bf; font-size: 0.8em; }
      #${CONTAINER_ID} .dq-cols-foot { position: sticky; bottom: 0; display: flex; justify-content: space-between; align-items: center; padding: 6px 10px; border-top: 1px solid #e8edf5; background: #f6f8fb; color: #788293; font-size: 0.8em; }
      #${CONTAINER_ID} .dq-table-row { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
      #${CONTAINER_ID} .dq-table-input { flex: 1 1 auto; min-width: 0; padding-right: 28px; }
      #${CONTAINER_ID} .dq-table-name { color: #45526b; font-weight: 600; }
      #${CONTAINER_ID} .dq-combo { position: relative; flex: 0 1 420px; min-width: 0; display: flex; }
      #${CONTAINER_ID} .dq-combo .dq-table-input { width: 100%; box-sizing: border-box; }
      #${CONTAINER_ID} .dq-combo-caret { position: absolute; top: 0; right: 0; height: 100%; width: 26px; display: flex; align-items: center; justify-content: center; border: 0; background: none; color: #788293; font: inherit; cursor: pointer; }
      #${CONTAINER_ID} .dq-combo-caret:hover { color: #1c69e1; }
      #${CONTAINER_ID} .dq-combo-panel { position: absolute; z-index: 5; top: calc(100% + 4px); left: 0; right: 0; max-height: 280px; overflow-y: auto; display: flex; flex-direction: column; background: #fff; border: 1px solid #d5dae2; border-radius: 6px; box-shadow: 0 6px 20px rgba(23, 33, 51, 0.14); }
      #${CONTAINER_ID} .dq-combo-panel[hidden] { display: none; }
      #${CONTAINER_ID} .dq-combo-opt { display: flex; gap: 10px; align-items: baseline; text-align: left; padding: 7px 10px; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
      #${CONTAINER_ID} .dq-combo-active { background: #eef4fd; }
      #${CONTAINER_ID} .dq-combo-current .dq-combo-name { color: #1c69e1; }
      #${CONTAINER_ID} .dq-combo-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-combo-tag { flex: 0 0 auto; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #aab2bf; font-size: 0.8em; }
      #${CONTAINER_ID} .dq-combo-empty { color: #788293; margin: 0; padding: 8px 10px; }
      #${CONTAINER_ID} .dq-combo-foot { position: sticky; bottom: 0; padding: 6px 10px; border-top: 1px solid #e8edf5; background: #f6f8fb; color: #788293; font-size: 0.8em; }
      #${CONTAINER_ID} .dq-combo-foot-warn { background: #fff6e5; color: #8a5a00; }
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
      #${CONTAINER_ID} .dq-saved-tools { display: flex; gap: 6px; }
      #${CONTAINER_ID} .dq-saved-tools .dq-btn { flex: 1 1 auto; }
      #${CONTAINER_ID} .dq-import-head { margin: 0 0 6px; font-size: 1.1em; }
      #${CONTAINER_ID} .dq-import-text { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; }
      #${CONTAINER_ID} .dq-hint { color: #788293; margin: 6px 0; }
      #${CONTAINER_ID} .dq-inputs { margin-top: 14px; padding: 12px 14px; border: 1px solid #c9dcf7; border-radius: 6px; background: #f7faff; }
      #${CONTAINER_ID} .dq-inputs-head { display: flex; gap: 10px; align-items: center; margin-bottom: 8px; }
      #${CONTAINER_ID} .dq-inputs-title { font-weight: 600; font-size: 0.9em; color: #45526b; }
      #${CONTAINER_ID} .dq-inputs-head .dq-btn-small { margin-top: 0; padding: 2px 8px; }
      #${CONTAINER_ID} .dq-inputs-row { display: flex; gap: 12px; flex-wrap: wrap; }
      #${CONTAINER_ID} .dq-input-field { display: flex; flex-direction: column; gap: 3px; flex: 0 1 220px; min-width: 0; }
      #${CONTAINER_ID} .dq-input-label { font-size: 0.8em; font-weight: 600; color: #45526b; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${CONTAINER_ID} .dq-input-box { width: 100%; box-sizing: border-box; }
      #${CONTAINER_ID} .dq-input-blank .dq-input-label { font-weight: 400; color: #788293; }
      #${CONTAINER_ID} .dq-input-summary { margin: 0 0 8px; color: #788293; font-size: 0.85em; }
      #${CONTAINER_ID} .dq-result { margin-top: 18px; }
      #${CONTAINER_ID} .dq-summary { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
      #${CONTAINER_ID} .dq-pager { display: flex; gap: 8px; align-items: center; }
      #${CONTAINER_ID} .dq-btn-page { padding: 3px 10px; font-size: 0.9em; }
      #${CONTAINER_ID} .dq-page-label { color: #45526b; font-size: 0.9em; white-space: nowrap; }
      #${CONTAINER_ID} .dq-count { font-weight: 600; }
      #${CONTAINER_ID} .dq-note { color: #788293; font-size: 0.85em; }
      /* \`none\`, not \`contain\`: contain still lets the grid rubber-band past its
         own edge, and it is that bounce — plus the back/forward swipe a
         horizontal one used to reach — that makes the table feel loose. */
      #${CONTAINER_ID} .dq-scroll { overflow: auto; max-height: 70vh; overscroll-behavior: none; border: 1px solid #d5dae2; border-radius: 6px; }
      #${CONTAINER_ID} .dq-scroll thead th { position: sticky; top: 0; z-index: 1; }
      #${CONTAINER_ID} .dq-table { border-collapse: collapse; width: 100%; }
      #${CONTAINER_ID} .dq-table th, #${CONTAINER_ID} .dq-table td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e8edf5; vertical-align: top; }
      #${CONTAINER_ID} .dq-table th { background: #f6f8fb; font-size: 0.85em; text-transform: uppercase; letter-spacing: 0.03em; color: #45526b; white-space: nowrap; }
      #${CONTAINER_ID} .dq-sortable { cursor: pointer; user-select: none; }
      #${CONTAINER_ID} .dq-sortable:hover { color: #1c69e1; }
      #${CONTAINER_ID} .dq-sortable:focus-visible { outline: 2px solid #1c69e1; outline-offset: -2px; }
      #${CONTAINER_ID} .dq-sorted { color: #1c69e1; }
      #${CONTAINER_ID} .dq-sort-ind { margin-left: 4px; }
      #${CONTAINER_ID} .dq-link { border: 0; background: none; padding: 0; font: inherit; color: #1c69e1; cursor: pointer; text-decoration: underline; }
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
        "Runs the same table API calls Tulip's own pages make, using this browser session's credentials — so you see exactly what your account can already see. Saved queries live in this browser's local storage for this Tulip instance; nothing is stored or sent anywhere by Tulbelt.",
      ),
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

    // No Run button to press: coming back to the page shows the answer to the
    // query in hand. A result already in state survived a tab switch, so it
    // stands rather than being re-fetched.
    if (!state.result && !state.loading && parseTableId(state.query.tableId)) {
      run({ reloadSchema: state.columns.length === 0, page: state.page });
    }

    // After the first paint — the picker is usable (and pasteable) without it,
    // and a refused list must not hold up the page. Re-fetched on each mount so
    // a table created since last visit shows up.
    state.tables = null;
    loadTables();
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
