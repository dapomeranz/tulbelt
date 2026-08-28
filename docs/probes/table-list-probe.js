// Finds the endpoint that lists every Tulip Table with its id and name, so the
// Data Queries query builder can offer a table picker instead of asking the
// user to paste an id (docs/toggles.md → "Data queries").
//
// Paste into the DevTools console of any *.tulip.co tab, page ("top") context.
//
//   await __tableProbe()          → try the candidate endpoints, print a report
//   __tableProbe.sniff()          → list the /api/ calls this tab has already
//                                   made (visit the Tables list page first)
//   copy(__tableProbeJson)          (typed alone at the prompt)
//
// Why a probe: Tulip's docs say GET /tables returns every table as
// `{ id, label, description, columns[] }` — exactly the shape the picker wants,
// and it carries `columns`, which would also retire the per-table metadata call
// data-queries.js makes today. What the docs *don't* settle is whether the
// credential we have works on it. Data Queries doesn't use an API token; it
// borrows the `Authorization: Basic …` header Tulip's own frontend sends
// (toggles/tulbelt-session-main.js). The docs describe /tables in terms of an
// API token holding the `tables:read` scope, and a session credential is a
// different animal. Whether the collection endpoint accepts it is an empirical
// question, and this answers it in one paste.
//
// The precedent says it should: toggles/submitted-pending-approvals.js already
// pages `/api/apps/v1/w/<ws>/apps?offset=&limit=&sort=name` with this same
// borrowed header, so a *collection* endpoint is not off-limits to the session
// credential in general. That toggle is also why the candidate list below isn't
// just the documented path — `apps` lives under its own `/api/apps/v1/`
// namespace while tables are still on flat `/api/v3/`, so if tables have since
// been given a namespace of their own, that is the shape it would take.
//
// If every candidate 401/403s, sniff() is the fallback: load the tenant's own
// Tables list page, then run it. Whatever endpoint that page uses is by
// definition reachable with the session's own credentials, and it will show up
// in the performance entries.
//
// Every request is a GET. Nothing is patched, written, or persisted, so there
// is nothing to undo. Table *names* are business data — the report masks them
// by default; pass `{ reveal: true }` if you want to read them, and treat that
// output like any other tenant data (chat or gitignored notes, never a tracked
// file).

(() => {
  // ── Session ─────────────────────────────────────────────────────────────────
  // Same two facts data-queries.js reads, obtained the same way: the sniffer
  // parks them on <html>, and performance entries cover the case where it ran
  // too late to catch the first call.

  const ROOT = document.documentElement;
  const WSID_RE = /\/api\/[^/]+\/v\d+\/w\/(\d+)\//;

  const sessionAuth = () => ROOT.getAttribute("data-tulbelt-auth") || "";

  function workspaceId() {
    const attr = ROOT.getAttribute("data-tulbelt-wsid");
    if (attr) return attr;
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const m = WSID_RE.exec(entry.name);
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

  // ── Candidates ──────────────────────────────────────────────────────────────
  // Ordered by how much we expect of them. The first is the documented list
  // endpoint under the workspace prefix Data Queries already uses successfully
  // for /tables/<id>/records, so it is the one shaped like a sibling of a call
  // we know works. The rest cover the ways that could be wrong: the workspace
  // as a header instead of a path segment, a `limit` the server rejects rather
  // than ignores, and the form with no workspace context at all.

  const candidates = (ws) => [
    {
      name: "v3 workspace path + paging",
      path: `/api/v3/w/${ws}/tables?limit=100&offset=0`,
      note: "documented list endpoint, workspace in the path",
    },
    {
      name: "v3 workspace path, no params",
      path: `/api/v3/w/${ws}/tables`,
      note: "in case limit/offset are rejected rather than ignored",
    },
    {
      name: "v3 + X-Tulip-Workspace-ID header",
      path: `/api/v3/tables?limit=100&offset=0`,
      headers: { "X-Tulip-Workspace-ID": ws },
      note: "documented alternative to the /w/<id> path segment",
    },
    {
      name: "v3 bare",
      path: `/api/v3/tables?limit=100&offset=0`,
      note: "single-workspace instances may not need the context at all",
    },
    {
      name: "apps-API paging convention",
      path: `/api/v3/w/${ws}/tables?offset=0&limit=100&sort=name`,
      note: "the params submitted-pending-approvals.js uses on /apps",
    },
    {
      name: "tables namespace",
      path: `/api/tables/v1/w/${ws}/tables?offset=0&limit=100`,
      note: "speculative — the shape /apps took when it left flat /api/v3",
    },
  ];

  // ── Fetch ───────────────────────────────────────────────────────────────────
  // Mirrors apiJson() in toggles/data-queries.js, including the one retry on
  // cookies alone: a sniffed header can be stale or scoped to something else,
  // and same-origin cookies often carry the session on their own. The retry is
  // reported separately, because "works only without the header" is a different
  // answer than "works" and would change how the picker calls it.

  async function attempt(path, extraHeaders) {
    const url = `${location.origin}${path}`;
    const base = { Accept: "application/json", "time-zone": timeZone(), ...(extraHeaders || {}) };
    const auth = sessionAuth();

    const send = (headers) => fetch(url, { credentials: "include", headers });

    let usedAuth = Boolean(auth);
    let resp = await send(auth ? { ...base, Authorization: auth } : base);
    if (auth && (resp.status === 401 || resp.status === 403)) {
      resp = await send(base);
      usedAuth = false;
    }

    const text = await resp.text().catch(() => "");
    let body = null;
    try {
      body = JSON.parse(text);
    } catch (_) {}

    return { url, status: resp.status, ok: resp.ok, usedAuth, body, text };
  }

  // ── Shape ───────────────────────────────────────────────────────────────────
  // The picker needs an id and a human name per table. The docs say the array
  // holds `{ id, label }`, but a wrapper object (`{ data: [...] }`) and a
  // different name field are both cheap to be wrong about, so describe what
  // actually came back rather than assert the documented shape.

  const NAME_KEYS = ["label", "name", "title", "displayName"];

  function describe(body, reveal) {
    if (body === null || body === undefined) return { kind: "non-JSON" };

    let list = null;
    let wrapper = null;
    if (Array.isArray(body)) {
      list = body;
    } else if (body && typeof body === "object") {
      for (const k of ["data", "tables", "results", "items", "records"]) {
        if (Array.isArray(body[k])) {
          list = body[k];
          wrapper = k;
          break;
        }
      }
    }
    if (!list) return { kind: "object", keys: Object.keys(body || {}).slice(0, 20) };

    const first = list[0] || {};
    const nameKey = NAME_KEYS.find((k) => typeof first[k] === "string") || null;
    const mask = (s) => (reveal ? s : String(s).replace(/\S/g, "•"));

    return {
      kind: "list",
      wrapper,
      count: list.length,
      itemKeys: Object.keys(first),
      idKey:
        typeof first.id === "string"
          ? "id"
          : Object.keys(first).find((k) => /id$/i.test(k)) || null,
      nameKey,
      hasColumns: Array.isArray(first.columns),
      columnCount: Array.isArray(first.columns) ? first.columns.length : null,
      sample: list.slice(0, 3).map((t) => ({
        id: t?.id ?? null,
        name: nameKey ? mask(t[nameKey]) : null,
      })),
    };
  }

  // ── Sniff ───────────────────────────────────────────────────────────────────
  // The fallback when nothing above is allowed. Tulip's own Tables list page
  // has to get this data somehow, and whatever it calls is reachable with the
  // credentials the session already has.

  function sniff() {
    let urls = [];
    try {
      urls = performance
        .getEntriesByType("resource")
        .map((e) => e.name)
        .filter((u) => u.includes("/api/"));
    } catch (_) {}

    const seen = new Set();
    const distinct = [];
    for (const u of urls) {
      // Collapse ids and query strings so repeated calls fold into one line.
      const shape = u
        .replace(location.origin, "")
        .split("?")[0]
        .replace(/\/[A-Za-z0-9_-]{15,}(?=\/|$)/g, "/<id>");
      if (seen.has(shape)) continue;
      seen.add(shape);
      distinct.push(shape);
    }

    distinct.sort();
    console.log(`%c${distinct.length} distinct /api/ paths seen in this tab`, "font-weight:bold");
    console.log(
      "Load the tenant's Tables list page, then run this again — look for a\n" +
        "collection path (no <id>) that could be returning the table list.",
    );
    distinct.forEach((p) => console.log("  " + p));
    window.__tableProbeSniff = distinct;
    return distinct;
  }

  // ── Run ─────────────────────────────────────────────────────────────────────

  async function run(opts) {
    const reveal = Boolean(opts && opts.reveal);
    const ws = workspaceId();
    const auth = sessionAuth();

    const report = {
      workspaceId: ws,
      workspaceIdSource: ROOT.hasAttribute("data-tulbelt-wsid")
        ? "sniffer"
        : "performance entries / default",
      sessionHeaderCaptured: Boolean(auth),
      attempts: [],
    };

    if (!auth) {
      console.warn(
        "No data-tulbelt-auth on <html>. Either the data-queries toggle is off,\n" +
          "or the sniffer loaded after Tulip's first API call. Cookies alone may\n" +
          "still be enough — continuing.",
      );
    }

    for (const c of candidates(ws)) {
      let res;
      try {
        res = await attempt(c.path, c.headers);
      } catch (err) {
        report.attempts.push({ name: c.name, note: c.note, path: c.path, error: String(err) });
        continue;
      }
      report.attempts.push({
        name: c.name,
        note: c.note,
        path: c.path,
        status: res.status,
        ok: res.ok,
        withSessionHeader: res.usedAuth,
        shape: res.ok ? describe(res.body, reveal) : undefined,
        errorBody: res.ok ? undefined : res.text.slice(0, 200),
      });
    }

    const winner = report.attempts.find((a) => a.ok && a.shape && a.shape.kind === "list");
    report.verdict = winner
      ? `USE: GET ${winner.path} → ${winner.shape.count} tables, id in "${winner.shape.idKey}", ` +
        `name in "${winner.shape.nameKey}"` +
        (winner.shape.hasColumns ? ", columns included (metadata call can go away)" : "")
      : "No candidate returned a list. Run __tableProbe.sniff() from the Tables list page.";

    console.log(`%c${report.verdict}`, "font-weight:bold");
    console.table(
      report.attempts.map((a) => ({
        candidate: a.name,
        status: a.status ?? "error",
        shape: a.shape ? `${a.shape.kind} (${a.shape.count ?? "-"})` : "-",
        sessionHeader: a.withSessionHeader,
      })),
    );
    console.log(report);

    window.__tableProbeJson = JSON.stringify(report, null, 2);
    console.log("Stashed. Type  copy(__tableProbeJson)  alone at the prompt to copy it.");
    return report;
  }

  run.sniff = sniff;
  window.__tableProbe = run;
  console.log("__tableProbe() ready. Also: __tableProbe.sniff(), __tableProbe({ reveal: true }).");
})();
