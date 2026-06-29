// Isolated-world half of submitted-pending-approvals.
//
// Reads auth/userId/wsId from data- attributes on <html>, written by the
// MAIN-world half (submitted-pending-approvals-main.js). The DOM is shared
// between both worlds; window.* properties are NOT — hence the attr channel.
//
//   document.documentElement.dataset.tulbeltSbaAuth   = "Basic <base64>"
//   document.documentElement.dataset.tulbeltSbaUid    = userId
//   document.documentElement.dataset.tulbeltSbaWsid   = wsId

(() => {
  const FEATURE_ID = "submitted-pending-approvals";
  const TOGGLES_KEY = "toggles";
  const PENDING_APPROVAL_URL_RE = /[?&]view=pendingApproval/;
  const INJECT_MARK = "data-tulbelt-sba";

  let enabled = false;
  let pageObserver = null;

  // ── Session state — read from <html> data- attrs set by MAIN world ──────────

  function getSession() {
    const d = document.documentElement.dataset;
    return {
      auth:   d.tulbeltSbaAuth   || null,
      userId: d.tulbeltSbaUid    || null,
      wsId:   d.tulbeltSbaWsid   || null,
    };
  }

  // Fallback: scrape performance entries to populate wsId/userId on <html>
  // for the case where the extension was reloaded into an already-open tab
  // (main-world script didn't run at document_start for this navigation).
  function scrapePerformanceEntries() {
    const d = document.documentElement.dataset;
    const APPS_PENDING_RE = /\/api\/apps\/v1\/w\/(\d+)\/apps-pending-approval[/?].*[?&]userId=([^&\s]+)/;
    const APPS_LIST_RE    = /\/api\/apps\/v1\/w\/(\d+)\/(?:folders\/[^/?#]+\/)?apps(?:[?#]|$)/;
    try {
      for (const entry of performance.getEntriesByType("resource")) {
        const url = entry.name;
        const pm = APPS_PENDING_RE.exec(url);
        if (pm) {
          if (!d.tulbeltSbaWsid) d.tulbeltSbaWsid = pm[1];
          if (!d.tulbeltSbaUid)  d.tulbeltSbaUid  = decodeURIComponent(pm[2]);
        }
        const lm = APPS_LIST_RE.exec(url);
        if (lm && !d.tulbeltSbaWsid) d.tulbeltSbaWsid = lm[1];
        if (d.tulbeltSbaWsid && d.tulbeltSbaUid) break;
      }
    } catch (_) {}
  }

  // ── API ─────────────────────────────────────────────────────────────────────

  // Shared headers/session guard for API calls.
  function requireSession() {
    scrapePerformanceEntries();
    const s = getSession();
    if (!s.auth || !s.userId || !s.wsId) {
      const missing = [!s.auth && "auth token", !s.userId && "user ID", !s.wsId && "workspace ID"]
        .filter(Boolean).join(", ");
      throw new Error(`Session not ready (missing: ${missing}) — hard-reload the page and try again.`);
    }
    return s;
  }

  function apiHeaders(auth) {
    return { Authorization: auth, "time-zone": "America/New_York" };
  }

  async function apiJson(url, auth) {
    const resp = await fetch(url, { credentials: "include", headers: apiHeaders(auth) });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`API error ${resp.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
    }
    return resp.json();
  }

  // Run async tasks with limited concurrency to avoid hammering the API.
  async function mapLimit(items, limit, fn) {
    const results = [];
    let i = 0;
    async function worker() {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  // Data source strategy (determined empirically — see PR notes):
  //   - apps-pending-approval?userId={me} only returns apps still awaiting the
  //     current user's approval; it drops apps once you've approved them.
  //   - The general /apps list does NOT embed pendingApproval, BUT apps that
  //     have a pending approval carry a truthy `pendingApprovalVersionId`.
  //   - The per-app versions endpoint
  //       /apps/{id}/versions?limit=20
  //     returns each version's `approvals[]` plus `created.by` (the submitter).
  //
  // So: page the apps list, keep the ~dozens with pendingApprovalVersionId,
  // then fetch versions for just those (limited concurrency), find the pending
  // version, and keep ones the current user submitted (created.by.id === me)
  // that still have at least one pending approval (from anyone). This surfaces
  // apps you submitted AND already approved but are waiting on others for.
  async function fetchAllPendingApps() {
    const { auth, wsId } = requireSession();

    // Stage 1: enumerate apps, keep those with a pending approval version.
    const limit = 50;
    let offset = 0;
    const candidates = [];
    while (true) {
      const data = await apiJson(
        `/api/apps/v1/w/${wsId}/apps?offset=${offset}&limit=${limit}&sort=name`,
        auth,
      );
      const items = Array.isArray(data) ? data : (data.items ?? data.apps ?? []);
      for (const app of items) {
        if (app.pendingApprovalVersionId) candidates.push(app);
      }
      if (items.length < limit) break;
      offset += limit;
    }

    // Stage 2: fetch versions for each candidate; attach the pending version's
    // approvals + submitter onto a synthesized pendingApproval object so the
    // rest of the code (filter/render) keeps the same shape it expects.
    await mapLimit(candidates, 6, async (app) => {
      try {
        const data = await apiJson(
          `/api/apps/v1/w/${wsId}/apps/${app.id}/versions?offset=0&limit=20`,
          auth,
        );
        const versions = Array.isArray(data) ? data : (data.items ?? data.versions ?? []);
        const pending =
          versions.find((v) => v.id === app.pendingApprovalVersionId) ??
          versions.find((v) => v.approvals?.some((a) => a.status === "pending"));
        if (pending) {
          app.pendingApproval = {
            versionId: pending.id,
            approvals: pending.approvals ?? [],
            requestedApproval: {
              at: pending.created?.at,
              by: pending.created?.by,
            },
          };
        }
      } catch (_) {
        // Skip apps whose versions we can't read (403/401 on some).
      }
    });

    return candidates.filter((app) => app.pendingApproval);
  }

  function filterSubmittedByMe(apps) {
    const { userId } = getSession();
    return apps.filter(
      (app) =>
        app.pendingApproval?.requestedApproval?.by?.id === userId &&
        app.pendingApproval?.approvals?.some((ap) => ap.status === "pending"),
    );
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const STYLES = `
    .tulbelt-sba-pill {
      display: inline-flex; align-items: center;
      background: #f0f4f8; border: 1px solid #d0d9e2; border-radius: 6px;
      padding: 2px; margin-left: 14px; vertical-align: middle;
      font-family: inherit; flex-shrink: 0;
    }
    .tulbelt-sba-btn {
      padding: 4px 13px; border: none; background: transparent;
      border-radius: 4px; cursor: pointer; font-size: 13px;
      font-family: inherit; color: #4a6078; line-height: 1.4;
      transition: background 0.1s, color 0.1s; white-space: nowrap;
    }
    .tulbelt-sba-btn.active {
      background: #fff; color: #1c69e1; font-weight: 500;
      box-shadow: 0 1px 3px rgba(0,0,0,0.09);
    }
    .tulbelt-sba-btn:hover:not(.active) { background: #e2ecf5; color: #2d4a63; }
    .tulbelt-sba-panel { padding: 16px 0 8px; }
    .tulbelt-sba-status {
      padding: 28px 24px; text-align: center; font-size: 14px; color: #6b7c8f;
    }
    .tulbelt-sba-error { color: #b03020; }
    .tulbelt-sba-summary { font-size: 13px; color: #6b7c8f; padding: 0 24px 10px; }
    .tulbelt-sba-card {
      background: #fff; border: 1px solid #e2e8ef; border-radius: 8px;
      padding: 11px 15px; margin: 0 24px 7px;
    }
    .tulbelt-sba-card:hover { border-color: #a8c8e8; }
    .tulbelt-sba-name {
      font-size: 14px; font-weight: 500; color: #1c69e1; margin: 0 0 1px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      display: block;
    }
    .tulbelt-sba-name-link { text-decoration: none; cursor: pointer; }
    .tulbelt-sba-name-link:hover { text-decoration: underline; }
    .tulbelt-sba-folder { font-size: 12px; color: #8a9aab; margin: 0 0 7px; }
    .tulbelt-sba-badges { display: flex; flex-wrap: wrap; gap: 4px; }
    .tulbelt-sba-badge { font-size: 11px; padding: 2px 7px; border-radius: 4px; white-space: nowrap; }
    .tulbelt-sba-pending  { background:#fff8e6; color:#8a6000; border:1px solid #edd87a; }
    .tulbelt-sba-accepted { background:#eafaf1; color:#1a7a45; border:1px solid #9de0ba; }
    .tulbelt-sba-other    { background:#f0f4f8; color:#4a6078; border:1px solid #c8d5e2; }
    .tulbelt-sba-submitted { font-size: 11px; color: #a0aab4; margin-top: 5px; }
  `;

  function ensureStyles() {
    if (document.getElementById("tulbelt-sba-style")) return;
    const el = document.createElement("style");
    el.id = "tulbelt-sba-style";
    el.setAttribute(INJECT_MARK, "true");
    el.textContent = STYLES;
    document.head.appendChild(el);
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
      });
    } catch (_) { return iso; }
  }

  function badgeClass(status) {
    if (status === "pending")  return "tulbelt-sba-badge tulbelt-sba-pending";
    if (status === "accepted") return "tulbelt-sba-badge tulbelt-sba-accepted";
    return "tulbelt-sba-badge tulbelt-sba-other";
  }

  function renderStatus(panel, msg, isError = false) {
    panel.innerHTML = `<div class="tulbelt-sba-status${isError ? " tulbelt-sba-error" : ""}">${esc(msg)}</div>`;
  }

  // Build the versions-list URL for an app, matching Tulip's route:
  //   /w/{slug}/apps/{appId}/versions
  // The path uses the workspace *slug* (e.g. DEFAULT) from the address bar,
  // not the numeric wsId used for the API.
  function appVersionUrl(app) {
    const slugMatch = /\/w\/([^/]+)\//.exec(location.pathname);
    const slug = slugMatch ? slugMatch[1] : "DEFAULT";
    const appId = app.id ?? app._id;
    if (!appId) return null;
    return `/w/${slug}/apps/${appId}/versions`;
  }

  function renderApps(panel, apps) {
    if (!apps.length) {
      renderStatus(panel, "No apps submitted by you are currently awaiting approval.");
      return;
    }
    const summary = document.createElement("div");
    summary.className = "tulbelt-sba-summary";
    summary.textContent = `${apps.length} app${apps.length !== 1 ? "s" : ""} you submitted ${apps.length !== 1 ? "are" : "is"} awaiting sign-off.`;

    const cards = apps.map((app) => {
      const card = document.createElement("div");
      card.className = "tulbelt-sba-card";
      const approvals = app.pendingApproval?.approvals ?? [];
      const badges = approvals.map((ap) => {
        const name = ap.approvalType?.name ?? ap.type?.name ?? ap.name ?? ap.status;
        return `<span class="${badgeClass(ap.status)}">${esc(name)}: ${esc(ap.status)}</span>`;
      }).join("");
      const submittedAt = app.pendingApproval?.requestedApproval?.at;
      const url = appVersionUrl(app);
      const nameHtml = url
        ? `<a class="tulbelt-sba-name tulbelt-sba-name-link" href="${esc(url)}">${esc(app.name)}</a>`
        : `<span class="tulbelt-sba-name">${esc(app.name)}</span>`;
      card.innerHTML = `
        ${nameHtml}
        <p class="tulbelt-sba-folder">${esc(app.parentFolder?.name ?? "")}</p>
        <div class="tulbelt-sba-badges">${badges}</div>
        ${submittedAt ? `<p class="tulbelt-sba-submitted">Submitted ${fmtDate(submittedAt)}</p>` : ""}
      `;
      return card;
    });

    panel.replaceChildren(summary, ...cards);
  }

  // ── Page injection ───────────────────────────────────────────────────────────

  function isPendingApprovalPage() {
    return PENDING_APPROVAL_URL_RE.test(location.search) ||
           PENDING_APPROVAL_URL_RE.test(location.href);
  }

  function findNativeList() {
    // The real list on the Pending Approvals page is the apps table, which
    // lives in the main content column (separate from the subheader/title
    // column where the heading + pill go).
    return (
      document.querySelector('[data-testid="apps-table"]') ??
      document.querySelector('[role="table"]') ??
      null
    );
  }

  // The apps-table's column wrapper — we hide this so the cards can take its
  // place in the same content column. We walk up from the table to the element
  // that is a direct child of the content row (the flex parent shared with the
  // subheader/title column). Styled-component class hashes change between Tulip
  // builds, so we navigate structurally rather than by class name.
  function findNativeListWrapper() {
    const table = findNativeList();
    if (!table) return null;
    // The table sits a couple levels deep inside its column. Hiding the table
    // itself is sufficient to clear the content area; do that as the safe
    // default, and additionally hide its immediate parent if that parent
    // contains nothing else meaningful.
    return table;
  }

  function findHeading() {
    return (
      document.querySelector('[data-testid="subheader-title"] h1') ??
      document.querySelector('[data-testid="page-title"]') ??
      document.querySelector("h1") ??
      null
    );
  }

  function teardown() {
    document.querySelectorAll(`[${INJECT_MARK}]`).forEach((el) => el.remove());
    const wrapper = findNativeListWrapper();
    if (wrapper) wrapper.style.display = "";
  }

  function inject() {
    if (!enabled || !isPendingApprovalPage()) return;
    if (document.querySelector(`.tulbelt-sba-pill[${INJECT_MARK}]`)) return;

    const heading = findHeading();
    if (!heading) return;

    ensureStyles();

    let panel = null;
    let currentView = "mine";

    const pill = document.createElement("span");
    pill.className = "tulbelt-sba-pill";
    pill.setAttribute(INJECT_MARK, "true");

    const btnMine = document.createElement("button");
    btnMine.type = "button";
    btnMine.className = "tulbelt-sba-btn active";
    btnMine.textContent = "Pending my approval";

    const btnOthers = document.createElement("button");
    btnOthers.type = "button";
    btnOthers.className = "tulbelt-sba-btn";
    btnOthers.textContent = "Submitted by me";

    async function switchTo(view) {
      currentView = view;
      btnMine.classList.toggle("active", view === "mine");
      btnOthers.classList.toggle("active", view === "others");

      const wrapper = findNativeListWrapper();

      if (view === "mine") {
        if (panel) panel.style.display = "none";
        if (wrapper) wrapper.style.display = "";
        return;
      }

      // "others" view — hide the apps-table wrapper and show our panel in the
      // same content column (as its sibling), so the cards occupy the main
      // area exactly where the table was.
      if (wrapper) wrapper.style.display = "none";

      if (!panel) {
        panel = document.createElement("div");
        panel.className = "tulbelt-sba-panel";
        panel.setAttribute(INJECT_MARK, "true");
        if (wrapper) {
          wrapper.insertAdjacentElement("afterend", panel);
        } else {
          const anchor =
            heading.closest("section, main, [role='main']") ?? heading.parentElement;
          anchor.insertAdjacentElement("afterend", panel);
        }
      } else {
        panel.style.display = "";
        // Re-home next to the wrapper if Tulip re-rendered the table.
        if (wrapper && panel.previousElementSibling !== wrapper) {
          wrapper.insertAdjacentElement("afterend", panel);
        }
      }

      renderStatus(panel, "Loading your submitted apps… (checking approval status)");

      try {
        const allApps = await fetchAllPendingApps();
        if (currentView === "others") {
          renderApps(panel, filterSubmittedByMe(allApps));
        }
      } catch (err) {
        if (currentView === "others") {
          renderStatus(panel, `Could not load apps: ${err.message}`, true);
        }
      }
    }

    btnMine.addEventListener("click", () => switchTo("mine"));
    btnOthers.addEventListener("click", () => switchTo("others"));
    pill.append(btnMine, btnOthers);
    heading.insertAdjacentElement("afterend", pill);
  }

  // ── SPA navigation observer ──────────────────────────────────────────────────

  let lastHref = location.href;

  function onMutation() {
    if (!enabled) return;
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      teardown();
    }
    if (isPendingApprovalPage()) inject();
  }

  function startObserver() {
    if (!pageObserver) {
      pageObserver = new MutationObserver(onMutation);
      pageObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (isPendingApprovalPage()) inject();
  }

  function stopObserver() {
    pageObserver?.disconnect();
    pageObserver = null;
    teardown();
  }

  // ── chrome.storage sync ──────────────────────────────────────────────────────

  function storageLocal() {
    return globalThis.chrome?.storage?.local ?? globalThis.browser?.storage?.local ?? null;
  }

  function isContextValid() {
    try { return Boolean(globalThis.chrome?.runtime?.id ?? globalThis.browser?.runtime?.id); }
    catch (_) { return false; }
  }

  async function syncFromStorage() {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    let next;
    try {
      const { [TOGGLES_KEY]: stored = {} } = await local.get(TOGGLES_KEY);
      next = stored[FEATURE_ID] === true;
    } catch (err) {
      if (/Extension context invalidated/i.test(err?.message)) return stopObserver();
      throw err;
    }
    if (next === enabled) return;
    enabled = next;
    if (enabled) startObserver();
    else stopObserver();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[TOGGLES_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
