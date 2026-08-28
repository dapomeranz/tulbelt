// Pure logic behind the Data Queries page: the filter/sort vocabulary, saved
// query storage, and query -> URL serialisation. No DOM, so it can be reasoned
// about (and tested) on its own; toggles/data-queries.js is the UI over it.
//
// The vocabulary here REPLICATES the contract of @locus-ot/tulip-api (v1.0.39)
// rather than importing it — that package is proprietary and this extension is
// MIT, and MV3 content scripts have no bundler to import through anyway. What
// is mirrored:
//
//   FilterFunctionType  -> OPERATORS below, all 16, ids verbatim
//   Filter              -> { field, functionType, arg? }
//   SortOption          -> { sortBy, sortDir: "asc" | "desc" }
//   FilterAggregator    -> "all" | "any"
//   buildQueryString()  -> queryToParams(): arrays/objects JSON.stringify'd,
//                          scalars String()'d, null/undefined dropped
//
// A saved query is therefore a valid `getRecords()` params object: what you
// build in the UI can be pasted straight into a Node script using the real
// library. If that library's filter contract ever changes, this file is the
// one place to update — the version above is the pin.
//
(() => {
  const LS_KEY = "tulbelt-data-queries";
  const STORE_VERSION = 1;
  // Every request asks for a full page of 100. The page used to carry a Limit
  // box; it was a foot-gun — a small limit silently truncates the answer, and
  // there is nothing a smaller page buys you. 100 is both the default and the
  // floor, so a query saved by an older build with `limit: 50` reads back as
  // 100. A hand-written query asking for more still gets what it asked for.
  const PAGE_LIMIT = 100;

  function normalizeLimit(limit) {
    const n = Number(limit);
    return Number.isFinite(n) && n > PAGE_LIMIT ? Math.floor(n) : PAGE_LIMIT;
  }

  // ── Filter vocabulary ───────────────────────────────────────────────────────

  // `arity`: 0 = no argument, 1 = one value, "list" = comma-separated -> string[]
  // `families`: which column types offer this operator. Order is display order.
  const OPERATORS = [
    { id: "equal", label: "is", arity: 1, families: ["text", "number", "time", "bool"] },
    { id: "notEqual", label: "is not", arity: 1, families: ["text", "number", "time", "bool"] },
    { id: "contains", label: "contains", arity: 1, families: ["text"] },
    { id: "notContains", label: "does not contain", arity: 1, families: ["text"] },
    { id: "startsWith", label: "starts with", arity: 1, families: ["text"] },
    { id: "notStartsWith", label: "does not start with", arity: 1, families: ["text"] },
    { id: "endsWith", label: "ends with", arity: 1, families: ["text"] },
    { id: "notEndsWith", label: "does not end with", arity: 1, families: ["text"] },
    { id: "greaterThan", label: "is after / >", arity: 1, families: ["number", "time"] },
    { id: "greaterThanOrEqual", label: "is at least / ≥", arity: 1, families: ["number", "time"] },
    { id: "lessThan", label: "is before / <", arity: 1, families: ["number", "time"] },
    { id: "lessThanOrEqual", label: "is at most / ≤", arity: 1, families: ["number", "time"] },
    { id: "isIn", label: "is any of", arity: "list", families: ["text", "number"] },
    { id: "notIsIn", label: "is none of", arity: "list", families: ["text", "number"] },
    { id: "blank", label: "is blank", arity: 0, families: ["text", "number", "time", "bool"] },
    {
      id: "notBlank",
      label: "is not blank",
      arity: 0,
      families: ["text", "number", "time", "bool"],
    },
  ];

  const OPERATOR_BY_ID = new Map(OPERATORS.map((o) => [o.id, o]));

  // Tulip's column dataType strings, bucketed into the families above. The API
  // doesn't publish an exhaustive list, so an unrecognised type deliberately
  // falls through to `null` and gets every operator — better to offer one that
  // errors than to silently hide the one the user needed.
  const TYPE_FAMILIES = {
    string: "text",
    text: "text",
    imageurl: "text",
    color: "text",
    user: "text",
    station: "text",
    machine: "text",
    appid: "text",
    barcode: "text",
    integer: "number",
    float: "number",
    number: "number",
    interval: "number",
    timestamp: "time",
    datetime: "time",
    date: "time",
    boolean: "bool",
  };

  function familyForType(dataType) {
    if (!dataType) return null;
    return TYPE_FAMILIES[String(dataType).toLowerCase()] || null;
  }

  function operatorsForType(dataType) {
    const family = familyForType(dataType);
    if (!family) return OPERATORS.slice();
    return OPERATORS.filter((o) => o.families.includes(family));
  }

  // ── Filter construction ─────────────────────────────────────────────────────

  function parseListArg(raw) {
    return String(raw ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Returns { filter } or { error }. `dataType` only steers coercion — the
  // value is still sent as typed when the column type isn't recognised.
  function buildFilter({ field, functionType, value, dataType }) {
    if (!field) return { error: "Pick a field." };
    const op = OPERATOR_BY_ID.get(functionType);
    if (!op) return { error: `Unknown operator "${functionType}".` };

    if (op.arity === 0) return { filter: { field, functionType } };

    if (op.arity === "list") {
      const arg = parseListArg(value);
      if (arg.length === 0) return { error: `"${op.label}" needs at least one value.` };
      return { filter: { field, functionType, arg } };
    }

    const text = String(value ?? "").trim();
    if (text === "") return { error: `"${op.label}" needs a value.` };

    const family = familyForType(dataType);
    if (family === "number") {
      const n = Number(text);
      if (!Number.isFinite(n)) return { error: `"${text}" isn't a number.` };
      return { filter: { field, functionType, arg: n } };
    }
    return { filter: { field, functionType, arg: text } };
  }

  // ── Query shape ─────────────────────────────────────────────────────────────

  function newId(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  }

  function emptyQuery(tableId = "") {
    return {
      id: null,
      name: "",
      tableId,
      rows: [], // builder rows; compiled to Filter[] on run
      filterAggregator: "all",
      sortOptions: [{ sortBy: "_createdAt", sortDir: "desc" }],
      limit: PAGE_LIMIT,
    };
  }

  // ── Runtime inputs ──────────────────────────────────────────────────────────

  // A filter value can carry `[Name]` placeholders, which turn the saved query
  // from a static report into a search tool: the name labels a box above the
  // grid, and what gets typed is substituted in before the query runs. A blank
  // box drops that filter entirely rather than searching for an empty string —
  // "no answer yet" means "don't narrow by this", which is what makes an
  // all-blank query show everything.
  //
  // Any bracketed run of text counts, so a value can be a bare placeholder
  // (`[Customer]`) or embed one (`ACME-[Suffix]`). There is deliberately no
  // escape for a literal bracket; see docs/toggles.md.
  const INPUT_RE = /\[([^\][]+)\]/g;

  // Every distinct placeholder across the rows, in first-seen order so the
  // search bar reads in the same order as the filters that use it. One name
  // used by two filters is one input feeding both.
  function parseInputs(rows) {
    const seen = new Set();
    const inputs = [];
    for (const row of rows || []) {
      const value = row?.value;
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(INPUT_RE)) {
        const name = m[1].trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        inputs.push({ name });
      }
    }
    return inputs;
  }

  // Substitutes what has been typed. Returns null when any placeholder in this
  // value has nothing behind it — the caller's signal to drop the filter, not
  // an error. A value with no placeholders passes through untouched, which is
  // why every query saved before this feature compiles exactly as it did.
  function resolveValue(template, inputs = {}) {
    if (typeof template !== "string" || !template.includes("[")) return template;
    let blank = false;
    const out = template.replace(INPUT_RE, (whole, rawName) => {
      const typed = inputs[rawName.trim()];
      const text = typed == null ? "" : String(typed);
      if (text.trim() === "") blank = true;
      return text;
    });
    return blank ? null : out;
  }

  // Builder rows carry the raw input; filters are compiled from them. Rows with
  // no field are ignored so a half-filled row never blocks a run, and so is a
  // row whose placeholders are still empty.
  function compileFilters(rows, columnTypes = {}, inputs = {}) {
    const filters = [];
    for (const row of rows) {
      if (!row.field) continue;
      const value = resolveValue(row.value, inputs);
      if (value === null) continue; // an input this filter needs is still blank
      const { filter, error } = buildFilter({
        field: row.field,
        functionType: row.functionType,
        value,
        dataType: columnTypes[row.field],
      });
      if (error) return { error };
      filters.push(filter);
    }
    return { filters };
  }

  // Mirrors buildQueryString() + getRecords()'s "omit when empty" rules, so the
  // URL matches what the library would have produced for the same params.
  function queryToParams(query, { offset = 0 } = {}) {
    const { filters, error } = compileFilters(query.rows, query.columnTypes || {}, query.inputs || {});
    if (error) return { error };

    const params = {
      limit: normalizeLimit(query.limit),
      offset,
      filterAggregator: query.filterAggregator || "all",
    };
    if (filters.length > 0) params.filters = filters;
    if (query.sortOptions?.length > 0) params.sortOptions = query.sortOptions;

    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) || typeof value === "object") {
        search.append(key, JSON.stringify(value));
      } else {
        search.append(key, String(value));
      }
    }
    return { search, filters };
  }

  // What a saved query keeps. Deliberately the getRecords() param set plus a
  // name — the builder rows come along so an edit round-trips, but `filters`
  // is what makes the record usable outside this UI.
  //
  // With runtime inputs those two halves say different things, on purpose.
  // `rows` keeps the templates (`[Customer]`), so reopening the query gives you
  // its search boxes back. `filters` is compiled against whatever was typed at
  // save time, with blank inputs dropped — a template has no valid compiled
  // form, and the whole point of `filters` is that it stays a runnable
  // getRecords() params object. Typed values themselves are never stored.
  function toSaved(query, filters) {
    const now = Date.now();
    return {
      id: query.id || newId("q"),
      name: query.name.trim(),
      tableId: query.tableId,
      filters,
      filterAggregator: query.filterAggregator || "all",
      sortOptions: query.sortOptions || [],
      limit: normalizeLimit(query.limit),
      rows: query.rows || [],
      createdAt: query.createdAt || now,
      updatedAt: now,
    };
  }

  function fromSaved(saved) {
    return {
      id: saved.id,
      name: saved.name || "",
      tableId: saved.tableId || "",
      rows: Array.isArray(saved.rows)
        ? saved.rows.map((r) => ({ ...r }))
        : rowsFromFilters(saved.filters),
      filterAggregator: saved.filterAggregator || "all",
      sortOptions: Array.isArray(saved.sortOptions) ? saved.sortOptions.map((s) => ({ ...s })) : [],
      limit: normalizeLimit(saved.limit),
      createdAt: saved.createdAt,
    };
  }

  // A query saved by an older build (or hand-written) may have filters but no
  // builder rows; rebuild editable rows from the filters so it still opens.
  function rowsFromFilters(filters) {
    if (!Array.isArray(filters)) return [];
    return filters.map((f) => ({
      field: f.field,
      functionType: f.functionType,
      value: Array.isArray(f.arg) ? f.arg.join(", ") : f.arg == null ? "" : String(f.arg),
    }));
  }

  // ── Share format (import / export) ──────────────────────────────────────────

  // One saved query, as a portable payload — the same idea as the option-sets
  // export: a small JSON blob you can paste to a colleague. Internal ids and
  // timestamps are local bookkeeping, so they are stripped here and minted
  // fresh on import; `queries` is an array so several can travel together even
  // though the UI exports one at a time.
  const SHARE_KIND = "data-queries";

  function toPortable(saved) {
    return {
      tulbelt: SHARE_KIND,
      version: 1,
      queries: [
        {
          name: saved.name,
          tableId: saved.tableId,
          filters: saved.filters || [],
          filterAggregator: saved.filterAggregator || "all",
          sortOptions: saved.sortOptions || [],
          limit: normalizeLimit(saved.limit),
          rows: saved.rows || [],
        },
      ],
    };
  }

  // Returns { queries } ready to store, or { error } with nothing changed.
  // Unknown fields are ignored and version > 1 is accepted, so a payload from a
  // newer Tulbelt still imports as long as the shape checks pass.
  function parseImport(text) {
    if (!String(text || "").trim()) return { error: "Nothing to import." };

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      return { error: `Not valid JSON (${err.message}).` };
    }
    if (!parsed || parsed.tulbelt !== SHARE_KIND) {
      return { error: "This doesn't look like a Tulbelt data queries export." };
    }

    // A single-query payload is the common hand-edited shape; accept it too.
    const list = Array.isArray(parsed.queries)
      ? parsed.queries
      : parsed.query
        ? [parsed.query]
        : null;
    if (!list) return { error: "This export has no queries in it." };

    const now = Date.now();
    const queries = [];
    for (const raw of list) {
      if (!raw || typeof raw.name !== "string" || !raw.name.trim()) {
        return { error: "Every query in the export needs a name." };
      }
      if (typeof raw.tableId !== "string" || !raw.tableId.trim()) {
        return { error: `Query "${raw.name}" has no table id.` };
      }
      if (raw.filters != null && !Array.isArray(raw.filters)) {
        return { error: `Query "${raw.name}" has a filters field that isn't a list.` };
      }
      const filters = Array.isArray(raw.filters) ? raw.filters : [];
      for (const f of filters) {
        if (!f || typeof f.field !== "string" || !OPERATOR_BY_ID.has(f.functionType)) {
          return { error: `Query "${raw.name}" has a filter this build doesn't understand.` };
        }
      }
      queries.push({
        id: newId("q"),
        name: raw.name.trim(),
        tableId: raw.tableId.trim(),
        filters,
        filterAggregator: raw.filterAggregator === "any" ? "any" : "all",
        sortOptions: Array.isArray(raw.sortOptions)
          ? raw.sortOptions
              .filter((o) => o && typeof o.sortBy === "string")
              .map((o) => ({ sortBy: o.sortBy, sortDir: o.sortDir === "asc" ? "asc" : "desc" }))
          : [],
        limit: normalizeLimit(raw.limit),
        // Builder rows are a UI convenience; rebuild them when absent so an
        // imported query is still editable rather than read-only.
        rows: Array.isArray(raw.rows) ? raw.rows.map((r) => ({ ...r })) : rowsFromFilters(filters),
        createdAt: now,
        updatedAt: now,
      });
    }
    return { queries };
  }

  // Two people importing the same query shouldn't end up with one entry each
  // time — but neither should an import quietly overwrite a local edit. A name
  // already in use gets a numeric suffix, the way a duplicated file does.
  function uniqueName(store, name) {
    const taken = new Set(store.queries.map((q) => q.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n += 1) {
      const candidate = `${name} (${n})`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  // ── Storage (tenant-origin localStorage) ────────────────────────────────────

  function emptyStore() {
    return { version: STORE_VERSION, lastTableId: "", queries: [] };
  }

  // Before saved queries existed this key held a bare table id — not JSON. Any
  // value that isn't a store object is therefore read as that legacy table id.
  function loadStore() {
    let raw;
    try {
      raw = localStorage.getItem(LS_KEY);
    } catch (err) {
      return { store: emptyStore(), error: `Couldn't read saved queries: ${err.message}` };
    }
    if (!raw) return { store: emptyStore() };

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      return { store: { ...emptyStore(), lastTableId: raw } };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { store: { ...emptyStore(), lastTableId: String(raw) } };
    }
    return {
      store: {
        version: STORE_VERSION,
        lastTableId: typeof parsed.lastTableId === "string" ? parsed.lastTableId : "",
        queries: Array.isArray(parsed.queries) ? parsed.queries : [],
      },
    };
  }

  function saveStore(store) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(store));
      return {};
    } catch (err) {
      return { error: `Couldn't save queries: ${err.message}` };
    }
  }

  function upsertQuery(store, saved) {
    const i = store.queries.findIndex((q) => q.id === saved.id);
    if (i === -1) store.queries.push(saved);
    else store.queries[i] = saved;
    store.queries.sort((a, b) => a.name.localeCompare(b.name));
    return store;
  }

  function removeQuery(store, id) {
    store.queries = store.queries.filter((q) => q.id !== id);
    return store;
  }

  window.__tulbeltDataQueriesModel = {
    LS_KEY,
    PAGE_LIMIT,
    normalizeLimit,
    OPERATORS,
    OPERATOR_BY_ID,
    familyForType,
    operatorsForType,
    parseListArg,
    buildFilter,
    compileFilters,
    parseInputs,
    resolveValue,
    queryToParams,
    emptyQuery,
    toSaved,
    fromSaved,
    rowsFromFilters,
    emptyStore,
    loadStore,
    saveStore,
    toPortable,
    parseImport,
    uniqueName,
    upsertQuery,
    removeQuery,
  };
})();
