// Main-world half of the app-list-date-columns feature.
//
// Lives in `world: "MAIN"`, `run_at: "document_start"` for two reasons:
//   1. The created / last-completed dates we want to show are NOT in the DOM —
//      they live only in the JSON the page fetches from
//      `/api/apps/v1/.../apps`. An isolated-world content script can't see the
//      page's own fetch/XHR responses, so we patch them here in the main world.
//   2. The patch must be installed before the page issues that request, hence
//      document_start.
//
// Two concerns:
//   * capture — a transparent fetch/XHR wrapper records `{ id -> {createdAt,
//     lastCompletedAt} }` into a Map. Always installed (it's a side-effect-free
//     read; nothing visible persists), independent of the toggle.
//   * columns — gated by `<html data-tulbelt-app-dates-enabled>` (set by the
//     isolated half). When on, two cells ("Created" / "Last Completed") are
//     injected after the Last Modified column on every app/folder list row and
//     the row's grid-template-columns is widened to match. Fully reverts off.

(() => {
  const ATTR = "data-tulbelt-app-dates-enabled";
  const ROW_SELECTOR = '[role="row"][widths]';
  const LAST_MODIFIED_HEADER = '[data-testid="header-lastModified.at"]';
  const COL_ATTR = "data-tulbelt-app-col";
  const SRC_ATTR = "data-tulbelt-appcol-src";
  const REORDER_ATTR = "data-tulbelt-reorder";
  const NEW_TRACK = "160px";
  const EMPTY = "—"; // em dash

  // id -> { createdAt, lastCompletedAt } (ISO strings). Filled by the capture
  // wrapper, read during injection.
  const dataById = new Map();

  let enabled = false;
  let rowObserver = null;
  let rafHandle = 0;

  // Authorization header lifted from any intercepted API call, reused for the
  // backfill re-fetch (the apps API needs a Basic token, not just cookies).
  let knownAuth = null;
  // Apps-list URLs we've already tried to re-fetch (one shot each, retried once
  // after we first learn the auth header).
  const backfillAttempted = new Set();
  let debug = false;
  function log(...a) {
    if (!debug) return;
    try {
      console.log("[tulbelt:appcols]", ...a);
    } catch (_) {}
  }

  function setAuth(value) {
    if (!value) return;
    const first = knownAuth == null;
    knownAuth = value;
    if (first) {
      // We may have given up on a backfill before we had the token — retry once.
      backfillAttempted.clear();
      if (enabled) maybeBackfill();
    }
  }

  // ---------- capture ----------

  // Merge an apps-API payload into dataById. Tolerant of shape — a bare array,
  // `{ items: [...] }`, or `{ apps: [...] }` of objects carrying an `id` are all
  // fair game (folder list, root apps list, paging, and the recents/favorites
  // endpoints, which use a different array shape).
  //
  // Merge is per-field, not whole-record: different endpoints carry different
  // slices of the truth (e.g. the `recents/apps?limit=6` response may omit
  // `lastCompleted`, the folder list omits nothing). A later, sparser response
  // must not clobber a date an earlier richer one already gave us, so we keep any
  // existing non-null value when the incoming one is null.
  function ingest(body) {
    if (!body || typeof body !== "object") return;
    const items = Array.isArray(body)
      ? body
      : Array.isArray(body.items)
        ? body.items
        : Array.isArray(body.apps)
          ? body.apps
          : null;
    if (!items) return;
    let changed = false;
    for (const item of items) {
      if (!item || typeof item !== "object" || typeof item.id !== "string") continue;
      const createdAt = item.created?.at ?? null;
      const lastCompletedAt = item.lastCompleted?.at ?? null;
      if (createdAt == null && lastCompletedAt == null) continue;
      const prev = dataById.get(item.id);
      const merged = {
        createdAt: createdAt ?? prev?.createdAt ?? null,
        lastCompletedAt: lastCompletedAt ?? prev?.lastCompletedAt ?? null,
      };
      if (
        !prev ||
        prev.createdAt !== merged.createdAt ||
        prev.lastCompletedAt !== merged.lastCompletedAt
      ) {
        dataById.set(item.id, merged);
        changed = true;
      }
    }
    // A row may have rendered before its data arrived — refresh shown cells.
    if (changed && enabled) scheduleApply();
  }

  // Matches any Tulip API list-of-apps endpoint whose path ends in `/apps`:
  //   /api/apps/v1/w/<n>/apps                     (root apps list)
  //   /api/apps/v1/w/<n>/folders/<id>/apps        (folder contents)
  //   /api/users/v1/w/<n>/users/<id>/recents/apps (Recents view)
  //   /api/users/v1/w/<n>/users/<id>/favorites/apps (Favorites view)
  // The `[^?#]*` keeps the match on the path so a stray `/apps` in a query
  // string can't trigger it.
  function isAppsListUrl(url) {
    return typeof url === "string" && /\/api\/[^?#]*\/apps(?:[?#]|$)/.test(url);
  }

  // Best-effort read of the Authorization header from fetch arguments.
  function authFromFetchArgs(args) {
    try {
      const [input, init] = args;
      const fromHeaders = (h) => {
        if (!h) return null;
        if (typeof Headers !== "undefined" && h instanceof Headers) return h.get("authorization");
        if (Array.isArray(h)) {
          const hit = h.find(([k]) => String(k).toLowerCase() === "authorization");
          return hit ? hit[1] : null;
        }
        if (typeof h === "object") {
          for (const k of Object.keys(h)) {
            if (k.toLowerCase() === "authorization") return h[k];
          }
        }
        return null;
      };
      return (
        fromHeaders(init?.headers) ||
        (input && typeof input === "object" && input.headers?.get?.("authorization")) ||
        null
      );
    } catch (_) {
      return null;
    }
  }

  function installCapture() {
    // fetch
    const origFetch = window.fetch;
    if (typeof origFetch === "function" && !origFetch.__tulbeltAppCols) {
      const wrapped = async function (...args) {
        try {
          setAuth(authFromFetchArgs(args));
        } catch (_) {}
        const res = await origFetch.apply(this, args);
        try {
          const url = res?.url || (typeof args[0] === "string" ? args[0] : args[0]?.url);
          if (isAppsListUrl(url)) {
            res
              .clone()
              .json()
              .then(ingest)
              .catch(() => {});
          }
        } catch (_) {}
        return res;
      };
      wrapped.__tulbeltAppCols = true;
      window.fetch = wrapped;
    }

    // XHR (some Tulip calls may not use fetch)
    const XHR = window.XMLHttpRequest;
    if (XHR && !XHR.prototype.__tulbeltAppCols) {
      const origOpen = XHR.prototype.open;
      const origSend = XHR.prototype.send;
      const origSetHeader = XHR.prototype.setRequestHeader;
      XHR.prototype.open = function (method, url, ...rest) {
        this.__tulbeltUrl = url;
        return origOpen.call(this, method, url, ...rest);
      };
      XHR.prototype.setRequestHeader = function (name, value) {
        try {
          if (String(name).toLowerCase() === "authorization") setAuth(value);
        } catch (_) {}
        return origSetHeader.call(this, name, value);
      };
      XHR.prototype.send = function (...args) {
        if (isAppsListUrl(this.__tulbeltUrl)) {
          this.addEventListener("load", () => {
            try {
              ingest(JSON.parse(this.responseText));
            } catch (_) {}
          });
        }
        return origSend.apply(this, args);
      };
      XHR.prototype.__tulbeltAppCols = true;
    }
  }

  // ---------- backfill (re-fetch the apps list ourselves) ----------
  //
  // Covers the case where the page's apps request completed before our wrapper
  // was installed (e.g. extension reloaded into an already-open tab). We read the
  // exact URL the page used from the resource-timing entries and re-issue it with
  // the captured Authorization header + cookies.

  function findAppsUrl() {
    const folder = /\/apps\/folders\/([^/?#]+)/.exec(location.pathname)?.[1];
    let fallback = null;
    try {
      const entries = performance.getEntriesByType("resource");
      for (let i = entries.length - 1; i >= 0; i--) {
        const name = entries[i].name;
        if (!isAppsListUrl(name)) continue;
        // Prefer the entry for the folder currently in the address bar.
        if (folder && name.includes(`/folders/${folder}/apps`)) return name;
        if (!fallback) fallback = name;
      }
    } catch (_) {}
    return fallback;
  }

  async function backfill(url) {
    if (!url || backfillAttempted.has(url)) return;
    backfillAttempted.add(url);
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: knownAuth ? { Authorization: knownAuth } : undefined,
      });
      log("backfill", res.status, url);
      if (res.ok) ingest(await res.json());
    } catch (e) {
      log("backfill failed", e?.message || e);
    }
  }

  function maybeBackfill() {
    if (!enabled) return;
    let missing = false;
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      if (isHeaderRow(row)) continue;
      const id = appIdOf(row);
      if (id && !dataById.has(id)) {
        missing = true;
        break;
      }
    }
    if (missing) backfill(findAppsUrl());
  }

  // ---------- helpers ----------

  // Splits a grid-template-columns–style string on top-level whitespace, so
  // `minmax(300px, 1fr) 44px` becomes ["minmax(300px, 1fr)", "44px"].
  // (Replicated from reorder-row-buttons.js — content scripts can't import.)
  function splitTrackList(str) {
    const tokens = [];
    let depth = 0;
    let current = "";
    for (const c of str) {
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (/\s/.test(c) && depth === 0) {
        if (current) {
          tokens.push(current);
          current = "";
        }
      } else {
        current += c;
      }
    }
    if (current) tokens.push(current);
    return tokens;
  }

  // Mirror reorder-row-buttons.js's permutation: pull the last two tracks into
  // slots 2 and 3 (next to the first). Used so our widened grid lines up with
  // reorder's CSS `order` rules when both toggles are on.
  function reorderPermute(tracks) {
    if (tracks.length < 4) return tracks;
    return [
      tracks[0],
      tracks[tracks.length - 2],
      tracks[tracks.length - 1],
      ...tracks.slice(1, -2),
    ];
  }

  function relativeTime(at) {
    const ts = Date.parse(at);
    if (Number.isNaN(ts)) return "";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  function absoluteTime(at) {
    const ts = Date.parse(at);
    return Number.isNaN(ts) ? "" : new Date(ts).toLocaleString();
  }

  // App id from a body row's link, or null for folder rows / non-app rows.
  function appIdOf(row) {
    const link = row.querySelector('a[href*="/apps/"]');
    const href = link?.getAttribute("href") || "";
    if (!href || href.includes("/apps/folders/")) return null;
    const m = /\/apps\/([^/?#]+)/.exec(href);
    return m ? m[1] : null;
  }

  function isHeaderRow(row) {
    return !!row.querySelector('[role="columnheader"]');
  }

  // Our columns belong only on app-list pages — paths containing an `/apps`
  // segment (the root list and `/apps/folders/<id>`) — and not on the
  // app-versions list (/apps/<id>/versions), which reuses the same `[role="row"]
  // [widths]` markup for versions, not apps. Path-checked at apply time because
  // SPA navigation can move on/off these pages without a reload.
  function isAppsPage() {
    return (
      /\/apps(?:\/|$)/.test(location.pathname) &&
      !/\/apps\/[^/?#]+\/versions(?:[/?#]|$)/.test(location.pathname)
    );
  }

  // Build one of our cells by cloning the Last Modified cell for styling, then
  // stripping interactive children and setting text.
  function buildCell(templateCell, role, which, text, title) {
    const cell = templateCell.cloneNode(true);
    cell.setAttribute(COL_ATTR, which);
    cell.removeAttribute("data-testid");
    // Drop any buttons/svgs/links the template carried (sort buttons, menus…).
    cell.querySelectorAll("button, svg, a").forEach((el) => el.remove());
    // Find the innermost text holder (the secondary <div>), else the cell itself.
    const holder = cell.querySelector("div") || cell;
    holder.textContent = text;
    if (title) holder.setAttribute("title", title);
    return cell;
  }

  function cellText(which, info) {
    const at = which === "created" ? info?.createdAt : info?.lastCompletedAt;
    return at ? relativeTime(at) || EMPTY : EMPTY;
  }

  function cellTitle(which, info) {
    const at = which === "created" ? info?.createdAt : info?.lastCompletedAt;
    return at ? absoluteTime(at) : "";
  }

  // ---------- per-row apply / restore ----------

  function applyRow(row) {
    const widths = row.getAttribute("widths") || "";
    const tracks = splitTrackList(widths);
    if (tracks.length < 2) return; // not a grid row we understand

    const header = isHeaderRow(row);
    const reorderActive = row.getAttribute(REORDER_ATTR) === "true";
    const signature = `${widths}|${reorderActive}`;

    // Desired grid: insert two tracks before the trailing two button columns,
    // then replicate reorder's permutation when reorder is active.
    let desiredTracks = [...tracks.slice(0, -2), NEW_TRACK, NEW_TRACK, ...tracks.slice(-2)];
    if (reorderActive) desiredTracks = reorderPermute(desiredTracks);
    const desiredGTC = desiredTracks.join(" ");

    const hasCells = row.querySelector(`[${COL_ATTR}]`);
    const currentGTC = row.style.getPropertyValue("grid-template-columns");
    if (hasCells && row.getAttribute(SRC_ATTR) === signature && currentGTC === desiredGTC) {
      // Layout unchanged — just keep body text fresh (data may have arrived late).
      if (!header) refreshRowText(row);
      return;
    }

    // Locate the two trailing cells (button columns) and the Last Modified cell
    // to clone for styling. Exclude our own cells from the count.
    const cellRole = header ? "columnheader" : "cell";
    const cells = [...row.querySelectorAll(`:scope > [role="${cellRole}"]:not([${COL_ATTR}])`)];
    if (cells.length < 3) return;
    const insertBefore = cells[cells.length - 2];
    const template = header ? row.querySelector(LAST_MODIFIED_HEADER) || cells[2] : cells[2];
    if (!insertBefore || !template) return;

    // Remove stale injected cells, then (re)insert fresh ones.
    row.querySelectorAll(`[${COL_ATTR}]`).forEach((el) => el.remove());

    const info = header ? null : dataById.get(appIdOf(row));
    const createdCell = header
      ? buildCell(template, cellRole, "created", "Created", "")
      : buildCell(
          template,
          cellRole,
          "created",
          cellText("created", info),
          cellTitle("created", info),
        );
    const completedCell = header
      ? buildCell(template, cellRole, "lastCompleted", "Last Completed", "")
      : buildCell(
          template,
          cellRole,
          "lastCompleted",
          cellText("lastCompleted", info),
          cellTitle("lastCompleted", info),
        );

    row.insertBefore(createdCell, insertBefore);
    row.insertBefore(completedCell, insertBefore);

    row.style.setProperty("grid-template-columns", desiredGTC, "important");
    row.setAttribute(SRC_ATTR, signature);
  }

  // Re-read data and update body cell text without rebuilding the row. Writes
  // are guarded against no-ops: setting textContent replaces a text node, which
  // is itself a childList mutation under our observed subtree — rewriting an
  // unchanged value would loop the observer forever.
  function refreshRowText(row) {
    const info = dataById.get(appIdOf(row));
    for (const which of ["created", "lastCompleted"]) {
      const cell = row.querySelector(`[${COL_ATTR}="${which}"]`);
      if (!cell) continue;
      const holder = cell.querySelector("div") || cell;
      const text = cellText(which, info);
      if (holder.textContent !== text) holder.textContent = text;
      const title = cellTitle(which, info);
      if (title) {
        if (holder.getAttribute("title") !== title) holder.setAttribute("title", title);
      } else if (holder.hasAttribute("title")) {
        holder.removeAttribute("title");
      }
    }
  }

  function restoreRow(row) {
    row.querySelectorAll(`[${COL_ATTR}]`).forEach((el) => el.remove());
    // Restore grid-template-columns to the non-our value. We can't just remove
    // the property — React's original was inline `!important` and would be lost
    // until the next render. Recompute from `widths`, replaying reorder's
    // permutation if it's active.
    const tracks = splitTrackList(row.getAttribute("widths") || "");
    if (tracks.length >= 2) {
      const restored = row.getAttribute(REORDER_ATTR) === "true" ? reorderPermute(tracks) : tracks;
      row.style.setProperty("grid-template-columns", restored.join(" "), "important");
    }
    row.removeAttribute(SRC_ATTR);
  }

  // ---------- enable / disable ----------

  function applyAll() {
    rafHandle = 0;
    // Off apps pages (or on the app-versions list), strip anything we may have
    // injected before navigating here and do nothing else.
    if (!isAppsPage()) {
      for (const row of document.querySelectorAll(`[${SRC_ATTR}]`)) restoreRow(row);
      return;
    }
    for (const row of document.querySelectorAll(ROW_SELECTOR)) applyRow(row);
    // If any app row is still missing its dates, the page's request likely
    // predated our capture wrapper — re-fetch it ourselves (one shot per URL).
    maybeBackfill();
  }

  function scheduleApply() {
    if (rafHandle) return;
    rafHandle = requestAnimationFrame(applyAll);
  }

  function onMutation() {
    scheduleApply();
  }

  function enable() {
    if (enabled) return;
    enabled = true;
    applyAll();
    if (!rowObserver) {
      rowObserver = new MutationObserver(onMutation);
      rowObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["widths", "style", REORDER_ATTR],
      });
    }
  }

  function disable() {
    if (!enabled) return;
    enabled = false;
    rowObserver?.disconnect();
    rowObserver = null;
    if (rafHandle) {
      cancelAnimationFrame(rafHandle);
      rafHandle = 0;
    }
    for (const row of document.querySelectorAll(`[${SRC_ATTR}]`)) restoreRow(row);
  }

  function readEnabled() {
    return document.documentElement.getAttribute(ATTR) === "true";
  }

  function syncEnabled() {
    if (readEnabled()) enable();
    else disable();
  }

  // ---------- boot ----------

  installCapture();

  // Watch the toggle-state attribute set by the isolated half. It may not exist
  // yet at document_start; the observer + an initial read cover both orders.
  new MutationObserver(syncEnabled).observe(document.documentElement, {
    attributes: true,
    attributeFilter: [ATTR],
  });

  // Debug aid (Rule 5): inspect captured data from the page console.
  //   __tulbeltAppCols.dump()         -> captured rows
  //   __tulbeltAppCols.state()        -> enabled / auth / backfill status
  //   __tulbeltAppCols.debug = true   -> log capture + backfill activity
  //   __tulbeltAppCols.backfill()     -> force a re-fetch now
  window.__tulbeltAppCols = {
    map: dataById,
    dump() {
      return [...dataById.entries()].map(([id, v]) => ({ id, ...v }));
    },
    state() {
      return {
        enabled,
        hasAuth: knownAuth != null,
        captured: dataById.size,
        appsUrl: findAppsUrl(),
        attempted: [...backfillAttempted],
      };
    },
    backfill() {
      backfillAttempted.clear();
      maybeBackfill();
    },
    get debug() {
      return debug;
    },
    set debug(v) {
      debug = !!v;
    },
  };

  if (document.body) syncEnabled();
  else document.addEventListener("DOMContentLoaded", syncEnabled, { once: true });
})();
