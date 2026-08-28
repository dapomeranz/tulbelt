// Finds how to enumerate the workspaces an account can reach, so the Data
// Queries table picker can list tables from all of them instead of only the
// workspace the current tab happens to be in (docs/toggles.md → "Data queries").
//
// Paste into the DevTools console of any *.tulip.co tab, page ("top") context.
//
//   await __wsProbe()             → try the candidate endpoints, then scan ids
//   await __wsProbe({ reveal: true })   → show workspace names in the report
//   __wsProbe.sniff()             → list /api/ paths this tab already called
//   copy(__wsProbeJson)             (typed alone at the prompt)
//
// Why a probe. The companion probe (table-list-probe.js) asked whether
// `GET /api/v3/w/<ws>/tables` accepts the session's borrowed credential. Running
// the picker answered it: yes — it returned 400 "extra param(s): limit, offset",
// which is the endpoint parsing our request and rejecting the query string, not
// refusing our credential. So /tables works, takes NO query string, and is
// unpaged. (The research note claiming 1–100 paging was wrong.)
//
// That leaves the harder question. `/tables` is scoped to one workspace by its
// `/w/<id>/` path segment, and nothing in Tulbelt knows which other workspaces
// exist: tulbelt-session-main.js sniffs exactly one numeric id off the first API
// call it sees, and the browser URL carries a slug (`/w/DEFAULT/`), not a
// number. Tulip must know the list — it renders a workspace switcher — but which
// call backs that is not something the docs settle.
//
// Two independent answers, both collected below:
//
//   Part 1  Candidate endpoints that might return the workspace list outright,
//           with names. This is the good outcome: real names in the picker.
//   Part 2  A direct scan of `/api/v3/w/N/tables` for N = 1..SCAN_MAX. This
//           cannot really fail — it uses only the call we now know works — and
//           answers "which workspace ids does this account reach" empirically.
//           It yields no names, so it is the fallback, not the goal.
//
// Part 2 also cross-checks Part 1: if a candidate claims six workspaces and only
// three serve tables, the picker should trust the scan.
//
// Every request is a GET. Nothing is patched, written, or persisted, so there is
// nothing to undo. Workspace and table names are business data — the report
// masks them unless you pass `{ reveal: true }`, and that output deserves the
// same care as any tenant data (chat or gitignored notes, never a tracked file).

(() => {
  const ROOT = document.documentElement;
  const WSID_RE = /\/api\/[^/]+\/v\d+\/w\/(\d+)\//;

  // How far the id scan walks. Instances number workspaces from 1 and the
  // numbering can have gaps (a deleted workspace leaves one), so the scan runs
  // the whole range rather than stopping at the first miss.
  const SCAN_MAX = 20;
  const SCAN_CONCURRENCY = 6;

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

  // ── Fetch ───────────────────────────────────────────────────────────────────
  // Mirrors apiJson() in toggles/data-queries.js, including the one retry on
  // cookies alone. The retry is reported separately: "works only without the
  // header" is a different answer from "works", and would change how the picker
  // has to call it.

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

  // ── Part 1: candidate workspace-list endpoints ──────────────────────────────
  // Ordered by expectation. The shapes covered, in order: a flat collection on
  // the same `/api/v3/` the tables calls live on; the same nested under a
  // workspace prefix (several Tulip collections require workspace context even
  // when the answer isn't workspace-specific); the current user's record, which
  // is where a membership list most often hides; and the per-service namespaces
  // Tulip has been migrating collections into (`/api/apps/v1/…` is the
  // precedent submitted-pending-approvals.js already relies on).

  const candidates = (ws) => [
    { name: "v3 flat", path: `/api/v3/workspaces`, note: "simplest form, no workspace context" },
    {
      name: "v3 under workspace",
      path: `/api/v3/w/${ws}/workspaces`,
      note: "same prefix the working /tables call uses",
    },
    {
      name: "v3 current user",
      path: `/api/v3/w/${ws}/users/me`,
      note: "a user record often carries its workspace memberships",
    },
    { name: "v3 me", path: `/api/v3/me`, note: "same idea, flat" },
    {
      name: "X-Tulip-Workspace-ID header",
      path: `/api/v3/workspaces`,
      headers: { "X-Tulip-Workspace-ID": ws },
      note: "documented alternative to the /w/<id> path segment",
    },
    {
      name: "users namespace",
      path: `/api/users/v1/w/${ws}/workspaces`,
      note: "speculative — per-service namespace, as /apps has",
    },
    {
      name: "apps namespace",
      path: `/api/apps/v1/w/${ws}/workspaces`,
      note: "the one namespace we know exists and is reachable",
    },
    {
      name: "instance namespace",
      path: `/api/instance/v1/workspaces`,
      note: "speculative — instance-level config is not workspace-scoped",
    },
  ];

  // What a workspace looks like, described rather than asserted: a list of
  // things each carrying an id and something name-shaped. A user record won't
  // be a list at the top level, so also look one level in.
  const NAME_KEYS = ["name", "label", "displayName", "title", "slug"];

  function describe(body, reveal) {
    if (body === null || body === undefined) return { kind: "non-JSON" };
    const mask = (s) => (reveal ? String(s) : String(s).replace(/\S/g, "•"));

    let list = null;
    let wrapper = null;
    if (Array.isArray(body)) list = body;
    else if (body && typeof body === "object") {
      for (const k of ["workspaces", "data", "results", "items", "memberships"]) {
        if (Array.isArray(body[k])) {
          list = body[k];
          wrapper = k;
          break;
        }
      }
    }

    if (!list) {
      return {
        kind: "object",
        keys: Object.keys(body || {}).slice(0, 25),
        // Call out anything workspace-shaped nested inside, which is how a
        // /me response would carry it.
        workspaceish: Object.keys(body || {}).filter((k) => /workspace/i.test(k)),
      };
    }

    const first = list[0] || {};
    const nameKey = NAME_KEYS.find((k) => typeof first[k] === "string") || null;
    const idKey =
      first.id !== undefined ? "id" : Object.keys(first).find((k) => /id$/i.test(k)) || null;

    return {
      kind: "list",
      wrapper,
      count: list.length,
      itemKeys: Object.keys(first),
      idKey,
      nameKey,
      sample: list.slice(0, 8).map((w) => ({
        id: idKey ? w[idKey] : null,
        name: nameKey ? mask(w[nameKey]) : null,
      })),
    };
  }

  // ── Part 2: scan workspace ids with the call we know works ──────────────────
  // /tables is unpaged and workspace-scoped, so one call per id says both
  // "does this workspace exist for me" and "what tables does it hold". A 200
  // with an array is a hit; 401/403/404 are all "not mine", reported distinctly
  // because a 403 (exists, no access) reads differently from a 404 (no such
  // workspace) when deciding how far to scan.

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(
      Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (i < items.length) {
          const idx = i++;
          out[idx] = await fn(items[idx], idx);
        }
      }),
    );
    return out;
  }

  async function scanWorkspaces(reveal) {
    const ids = Array.from({ length: SCAN_MAX }, (_, i) => String(i + 1));
    const mask = (s) => (reveal ? String(s) : String(s).replace(/\S/g, "•"));

    return mapLimit(ids, SCAN_CONCURRENCY, async (id) => {
      let res;
      try {
        res = await attempt(`/api/v3/w/${id}/tables`);
      } catch (err) {
        return { wsId: id, status: "error", detail: String(err) };
      }
      const list = Array.isArray(res.body)
        ? res.body
        : Array.isArray(res.body?.tables)
          ? res.body.tables
          : null;
      return {
        wsId: id,
        status: res.status,
        reachable: Boolean(res.ok && list),
        tableCount: list ? list.length : null,
        withSessionHeader: res.usedAuth,
        sampleTable: list && list[0] ? mask(list[0].label ?? list[0].name ?? "") : null,
        errorBody: res.ok ? undefined : res.text.slice(0, 120),
      };
    });
  }

  // ── Sniff ───────────────────────────────────────────────────────────────────
  // The fallback when no candidate answers. Tulip renders a workspace switcher,
  // so something in this tab has the list; open that switcher, then run this.

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
      const shape = u
        .replace(location.origin, "")
        .split("?")[0]
        .replace(/\/[A-Za-z0-9_-]{15,}(?=\/|$)/g, "/<id>");
      if (seen.has(shape)) continue;
      seen.add(shape);
      distinct.push(shape);
    }
    distinct.sort();

    const interesting = distinct.filter((p) =>
      /workspace|user|me\b|session|config|bootstrap/i.test(p),
    );
    console.log(`%c${distinct.length} distinct /api/ paths seen in this tab`, "font-weight:bold");
    if (interesting.length) {
      console.log("%cWorkspace/user/config-shaped ones:", "font-weight:bold");
      interesting.forEach((p) => console.log("  ★ " + p));
    }
    console.log(
      "Open the workspace switcher in Tulip's header, then run this again —\n" +
        "whatever call backs that menu is reachable with this session.",
    );
    distinct.forEach((p) => console.log("  " + p));
    window.__wsProbeSniff = distinct;
    return distinct;
  }

  // ── Run ─────────────────────────────────────────────────────────────────────

  async function run(opts) {
    const reveal = Boolean(opts && opts.reveal);
    const ws = workspaceId();
    const auth = sessionAuth();

    if (!auth) {
      console.warn(
        "No data-tulbelt-auth on <html>. Either the data-queries toggle is off,\n" +
          "or the sniffer loaded after Tulip's first API call. Cookies alone may\n" +
          "still be enough — continuing.",
      );
    }

    const report = {
      origin: location.origin,
      ambientWorkspaceId: ws,
      sessionHeaderCaptured: Boolean(auth),
      candidates: [],
      scan: [],
    };

    console.log("%cPart 1 — candidate workspace-list endpoints", "font-weight:bold");
    for (const c of candidates(ws)) {
      let res;
      try {
        res = await attempt(c.path, c.headers);
      } catch (err) {
        report.candidates.push({ name: c.name, path: c.path, note: c.note, error: String(err) });
        continue;
      }
      report.candidates.push({
        name: c.name,
        path: c.path,
        note: c.note,
        status: res.status,
        ok: res.ok,
        withSessionHeader: res.usedAuth,
        shape: res.ok ? describe(res.body, reveal) : undefined,
        errorBody: res.ok ? undefined : res.text.slice(0, 160),
      });
    }
    console.table(
      report.candidates.map((c) => ({
        candidate: c.name,
        status: c.status ?? "error",
        shape: c.shape ? `${c.shape.kind} (${c.shape.count ?? "-"})` : "-",
        nameKey: c.shape?.nameKey ?? "-",
        sessionHeader: c.withSessionHeader,
      })),
    );

    console.log(`%cPart 2 — scanning /api/v3/w/1..${SCAN_MAX}/tables`, "font-weight:bold");
    report.scan = await scanWorkspaces(reveal);
    const reachable = report.scan.filter((s) => s.reachable);
    console.table(
      report.scan.map((s) => ({
        workspace: s.wsId,
        status: s.status,
        reachable: s.reachable ?? false,
        tables: s.tableCount ?? "-",
      })),
    );

    // ── Verdict ───────────────────────────────────────────────────────────────
    const winner = report.candidates.find(
      (c) => c.ok && c.shape && c.shape.kind === "list" && c.shape.count > 0 && c.shape.idKey,
    );
    const nested = report.candidates.find((c) => c.ok && c.shape?.workspaceish?.length);

    report.reachableWorkspaceIds = reachable.map((s) => s.wsId);
    report.totalTables = reachable.reduce((n, s) => n + (s.tableCount || 0), 0);

    report.verdict = [
      winner
        ? `NAMES: GET ${winner.path} → ${winner.shape.count} workspaces, ` +
          `id in "${winner.shape.idKey}", name in "${winner.shape.nameKey}"`
        : nested
          ? `MAYBE: GET ${nested.path} returned an object with ${nested.shape.workspaceish.join(", ")} — inspect it in the log`
          : "NAMES: no candidate returned a workspace list. Run __wsProbe.sniff() with the workspace switcher open.",
      reachable.length
        ? `IDS: ${reachable.length} workspace(s) serve tables — ${report.reachableWorkspaceIds.join(", ")} ` +
          `(${report.totalTables} tables total). The picker can use these with no list endpoint at all.`
        : `IDS: the scan found nothing reachable, which contradicts the picker working — check that the toggle is on.`,
      reachable.length && reachable.some((s) => s.wsId === String(SCAN_MAX))
        ? `NOTE: workspace ${SCAN_MAX} answered, so the scan may have stopped short — raise SCAN_MAX and rerun.`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    console.log(`%c${report.verdict}`, "font-weight:bold");
    console.log(report);

    window.__wsProbeJson = JSON.stringify(report, null, 2);
    console.log("Stashed. Type  copy(__wsProbeJson)  alone at the prompt to copy it.");
    return report;
  }

  run.sniff = sniff;
  window.__wsProbe = run;
  console.log("__wsProbe() ready. Also: __wsProbe.sniff(), __wsProbe({ reveal: true }).");
})();
