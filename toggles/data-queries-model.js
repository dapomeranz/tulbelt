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
  const DEFAULT_LIMIT = 50;

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
    { id: "notBlank", label: "is not blank", arity: 0, families: ["text", "number", "time", "bool"] },
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
      limit: DEFAULT_LIMIT,
    };
  }

  // Builder rows carry the raw input; filters are compiled from them. Rows with
  // no field are ignored so a half-filled row never blocks a run.
  function compileFilters(rows, columnTypes = {}) {
    const filters = [];
    for (const row of rows) {
      if (!row.field) continue;
      const { filter, error } = buildFilter({
        field: row.field,
        functionType: row.functionType,
        value: row.value,
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
    const { filters, error } = compileFilters(query.rows, query.columnTypes || {});
    if (error) return { error };

    const params = {
      limit: query.limit ?? DEFAULT_LIMIT,
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
  function toSaved(query, filters) {
    const now = Date.now();
    return {
      id: query.id || newId("q"),
      name: query.name.trim(),
      tableId: query.tableId,
      filters,
      filterAggregator: query.filterAggregator || "all",
      sortOptions: query.sortOptions || [],
      limit: query.limit ?? DEFAULT_LIMIT,
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
      rows: Array.isArray(saved.rows) ? saved.rows.map((r) => ({ ...r })) : rowsFromFilters(saved.filters),
      filterAggregator: saved.filterAggregator || "all",
      sortOptions: Array.isArray(saved.sortOptions) ? saved.sortOptions.map((s) => ({ ...s })) : [],
      limit: saved.limit ?? DEFAULT_LIMIT,
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
    DEFAULT_LIMIT,
    OPERATORS,
    OPERATOR_BY_ID,
    familyForType,
    operatorsForType,
    parseListArg,
    buildFilter,
    compileFilters,
    queryToParams,
    emptyQuery,
    toSaved,
    fromSaved,
    rowsFromFilters,
    emptyStore,
    loadStore,
    saveStore,
    upsertQuery,
    removeQuery,
  };
})();
