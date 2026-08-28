// Logs every app-editor and table page the user opens, and adds a ⌘K/Ctrl+K
// search palette to jump back to any of them by name or folder.
//
// Two concerns live here:
//   - recorder: watches SPA navigations, reads the breadcrumb title once it has
//     rendered, and upserts an entry into history (MRU, deduped by kind+id).
//   - palette: a shadow-DOM overlay opened on ⌘K/Ctrl+K that substring-filters the
//     recorded history and navigates to the chosen entry.
//
// History lives under its own storage key (HISTORY_KEY), separate from the
// `toggles` flag, like auto-snapshot.js's autoSnapshotState. Disabling the
// toggle removes the listener/observer/overlay (reverting cleanly) but leaves
// recorded history in storage — it is data, not a page mutation.

(() => {
  const { addedNodesObserver } = window.__tulbeltLib;

  const FEATURE_ID = "history-search";
  const TOGGLES_KEY = "toggles";
  const HISTORY_KEY = "tulbelt:history";
  const MAX_ENTRIES = 100;
  const POLL_MS = 700;
  const SETTLE_DEBOUNCE_MS = 250;

  const TABLE_RE = /^https?:\/\/([^.]+)\.tulip\.co(?:\/w\/[^/]+)?\/table\/([^/?#]+)/;
  const APP_RE = /^https?:\/\/([^.]+)\.tulip\.co(?:\/w\/[^/]+)?\/apps\/([^/]+)\/versions(\/|$)/;
  const CONNECTOR_RE =
    /^https?:\/\/([^.]+)\.tulip\.co(?:\/w\/[^/]+)?\/connector\/[^/]+\/function\/([^/?#]+)/;

  let enabled = false;
  let observer = null;
  let pollHandle = null;
  let settleTimer = null;
  let history = [];

  // --- chrome.* robustness (mirrors auto-snapshot.js) -----------------------

  /** MV3 content scripts usually expose `chrome.storage`; some builds use `browser`. */
  function storageLocal() {
    return globalThis.chrome?.storage?.local ?? globalThis.browser?.storage?.local ?? null;
  }

  function isContextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id ?? globalThis.browser?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    return /Extension context invalidated|Extension manifest must request permission/i.test(
      err?.message ?? "",
    );
  }

  // --- page detection -------------------------------------------------------

  // Returns { kind, id } for the current URL, or null if it isn't an app/table.
  function pageKey(url = location.href) {
    const t = TABLE_RE.exec(url);
    if (t) return { kind: "table", id: t[2] };
    const a = APP_RE.exec(url);
    if (a) return { kind: "app", id: a[2] };
    const c = CONNECTOR_RE.exec(url);
    if (c) return { kind: "connector", id: c[2] };
    return null;
  }

  function titleText() {
    const h1 = document.querySelector('[data-testid="subheader-title"] h1');
    return h1?.textContent?.trim() ?? "";
  }

  function rootLabel() {
    const root = document.querySelector('[data-testid="subheader-root-breadcrumb"]');
    return root?.textContent?.trim() ?? "";
  }

  function folderPath() {
    const crumbs = document.querySelectorAll('a[data-testid="subheader-breadcrumb"]');
    return [...crumbs]
      .map((a) => a.textContent.trim())
      .filter(Boolean)
      .join(" / ");
  }

  // --- recorder -------------------------------------------------------------

  async function loadHistory() {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    try {
      const { [HISTORY_KEY]: stored = [] } = await local.get(HISTORY_KEY);
      history = Array.isArray(stored) ? stored : [];
    } catch (err) {
      if (isContextInvalidatedError(err)) stop();
      else throw err;
    }
  }

  // Re-read before writing so two tabs don't clobber each other's history.
  async function upsertEntry(entry) {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    try {
      const { [HISTORY_KEY]: stored = [] } = await local.get(HISTORY_KEY);
      const list = Array.isArray(stored) ? stored : [];
      const next = list.filter((e) => !(e.kind === entry.kind && e.id === entry.id));
      next.unshift(entry);
      next.length = Math.min(next.length, MAX_ENTRIES);
      history = next;
      await local.set({ [HISTORY_KEY]: next });
    } catch (err) {
      if (isContextInvalidatedError(err)) stop();
      else throw err;
    }
  }

  // Record the current page if it's an app/table and its name has rendered.
  function recordCurrent() {
    const key = pageKey();
    if (!key) return;
    const name = titleText();
    if (!name) return; // breadcrumb not settled yet — wait for the next tick.
    upsertEntry({
      kind: key.kind,
      id: key.id,
      name,
      folder: folderPath(),
      root: rootLabel(),
      url: location.href,
      ts: Date.now(),
    });
  }

  function scheduleRecord() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(recordCurrent, SETTLE_DEBOUNCE_MS);
  }

  function startRecorder() {
    if (!observer) {
      observer = new MutationObserver(scheduleRecord);
      observer.observe(document.body, { childList: true, subtree: true });
    }
    // The observer misses some same-document URL swaps; a light poll backs it up.
    if (!pollHandle) pollHandle = setInterval(scheduleRecord, POLL_MS);
    scheduleRecord();
  }

  function stopRecorder() {
    observer?.disconnect();
    observer = null;
    clearInterval(pollHandle);
    pollHandle = null;
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  // --- palette overlay ------------------------------------------------------

  const ROOT_FALLBACK = { table: "Tables", app: "Apps", connector: "Connectors" };

  const HOST_ID = "tulbelt-history-host";
  const NAV_ANCHOR = "#factory-recent-activity";
  const NAV_MARK = "data-tulbelt-history-nav";
  // Material search glyph, sized like factory-recent-activity / factory-help icons.
  const NAV_SEARCH_SVG =
    '<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true">' +
    '<path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C8.01 14 6 11.99 6 9.5S8.01 5 10.5 5 15 7.01 15 9.5 12.99 14 10.5 14z"></path>' +
    "</svg>";

  let host = null;
  let root = null;
  let inputEl = null;
  let listEl = null;
  let selectedIndex = 0;
  let filtered = [];

  // Tulip-inspired palette: flush search header, link-style list rows.
  const STYLE = `
  :host { all: initial; }
  .backdrop {
    position: fixed; inset: 0; z-index: 2147483647;
    background: rgba(15, 28, 44, 0.32);
    display: flex; align-items: flex-start; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  .panel {
    margin-top: 10vh; width: min(720px, 94vw);
    background: #fff; color: #0f1c2c;
    border-radius: 8px; box-shadow: 0 4px 24px rgba(15, 28, 44, 0.14);
    overflow: hidden; display: flex; flex-direction: column;
  }
  .search-wrap {
    flex-shrink: 0; padding: 0; background: #f7f9fb;
    border-bottom: 1px solid #e8ecf0;
  }
  .search-field { position: relative; display: flex; align-items: center; }
  .search-icon {
    position: absolute; left: 16px; top: 50%; transform: translateY(-50%);
    width: 18px; height: 18px; color: #6b7c8f; pointer-events: none;
  }
  slot[name="search"] { display: flex; flex: 1; min-width: 0; }
  ::slotted(input) {
    border: 0; outline: 0; margin: 0;
    padding: 14px 16px 14px 44px; font-size: 15px; width: 100%;
    box-sizing: border-box; background: transparent; color: #0f1c2c;
  }
  ::slotted(input)::placeholder { color: #8a9aab; }
  ::slotted(input:focus) { background: #fff; }
  .search-field:focus-within .search-icon { color: #1c69e1; }
  ul { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow-y: auto; }
  li {
    padding: 12px 24px; cursor: pointer;
    display: flex; flex-direction: column; gap: 4px;
    border-bottom: 1px solid #e8ecf0;
  }
  li.sel { background: #e8f4fd; }
  .name { font-size: 14px; font-weight: 400; color: #1c69e1; line-height: 1.35; }
  .meta {
    font-size: 12px; color: #6b7c8f; display: flex; flex-wrap: wrap;
    gap: 4px 10px; line-height: 1.35;
  }
  .meta .sep::before { content: "·"; margin-right: 10px; color: #c7ced6; }
  .empty { padding: 20px 24px; color: #6b7c8f; font-size: 14px; }
`;

  function relativeTime(ts) {
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return "just now";
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  }

  function buildOverlay() {
    host = document.createElement("div");
    host.id = HOST_ID;

    // Light-DOM input slotted into the shadow panel. Events from slotted nodes
    // are not retargeted to the host, so Tulip's "ignore keys while typing in a
    // field" guard sees a real <input> instead of #tulbelt-history-host.
    inputEl = document.createElement("input");
    inputEl.type = "text";
    inputEl.slot = "search";
    inputEl.placeholder = "Search apps & tables";
    inputEl.setAttribute("aria-label", "Search apps and tables");
    host.appendChild(inputEl);

    root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = STYLE;

    const backdrop = document.createElement("div");
    backdrop.className = "backdrop";

    const panel = document.createElement("div");
    panel.className = "panel";

    const searchWrap = document.createElement("div");
    searchWrap.className = "search-wrap";
    const searchField = document.createElement("div");
    searchField.className = "search-field";
    const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    searchIcon.setAttribute("class", "search-icon");
    searchIcon.setAttribute("viewBox", "0 0 16 16");
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.innerHTML =
      '<path fill="currentColor" d="M7 2a5 5 0 1 1 0 10A5 5 0 0 1 7 2Zm0-1a6 6 0 1 0 3.55 10.9l3.2 3.2.7-.7-3.2-3.2A6 6 0 0 0 7 1Z"/>';
    const searchSlot = document.createElement("slot");
    searchSlot.name = "search";
    searchField.append(searchIcon, searchSlot);
    searchWrap.append(searchField);

    listEl = document.createElement("ul");

    panel.append(searchWrap, listEl);
    backdrop.append(panel);
    root.append(style, backdrop);

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) closeOverlay();
    });
    inputEl.addEventListener("input", renderList);
    inputEl.addEventListener("keydown", onInputKeydown);

    // Tulip binds single-character hotkeys on document-level listeners. Key
    // events from our input bubble out of the shadow DOM and reach them —
    // retargeted to the host element, so Tulip's "ignore keys while typing in a
    // field" guard misses our <input> and fires the hotkey. Swallow key events
    // at the overlay so they never escape to the page. Our own handlers
    // (onInputKeydown on the input below this in the tree; the ⌘K/Ctrl+K toggle in
    // capture phase on window) run before this and are unaffected.
    const swallow = (e) => e.stopPropagation();
    for (const type of ["keydown", "keypress", "keyup"]) {
      backdrop.addEventListener(type, swallow);
    }

    document.body.appendChild(host);
  }

  // Only surface history from the instance you're currently on — never span
  // across tulip.co instances (each subdomain is a separate instance).
  function sameInstance(url) {
    try {
      return new URL(url, location.href).host === location.host;
    } catch {
      return false;
    }
  }

  function renderList() {
    const q = inputEl.value.trim().toLowerCase();
    // Hide the page you're already on — re-opening it is a no-op.
    const here = pageKey();
    const pool = history.filter(
      (e) => sameInstance(e.url) && !(here && e.kind === here.kind && e.id === here.id),
    );
    filtered = q
      ? pool.filter((e) => `${e.name} ${e.folder}`.toLowerCase().includes(q))
      : pool.slice();
    selectedIndex = 0;
    listEl.replaceChildren();

    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = q ? "No matches." : "No history yet — open an app or table.";
      listEl.append(empty);
      return;
    }

    filtered.forEach((entry, i) => {
      const li = document.createElement("li");
      if (i === selectedIndex) li.className = "sel";

      const name = document.createElement("div");
      name.className = "name";
      name.textContent = entry.name;

      const meta = document.createElement("div");
      meta.className = "meta";
      const rootSpan = document.createElement("span");
      rootSpan.textContent = entry.root || ROOT_FALLBACK[entry.kind] || "Apps";
      meta.append(rootSpan);
      if (entry.folder) {
        const folder = document.createElement("span");
        folder.className = "sep";
        folder.textContent = entry.folder;
        meta.append(folder);
      }
      const time = document.createElement("span");
      time.className = "sep";
      time.textContent = relativeTime(entry.ts);
      meta.append(time);

      li.append(name, meta);
      li.addEventListener("click", (e) => {
        openEntry(entry, e.ctrlKey || e.metaKey);
      });
      li.addEventListener("auxclick", (e) => {
        if (e.button === 1) openEntry(entry, true);
      });
      listEl.append(li);
    });
  }

  function moveSelection(delta) {
    if (!filtered.length) return;
    selectedIndex = (selectedIndex + delta + filtered.length) % filtered.length;
    [...listEl.children].forEach((li, i) => li.classList?.toggle("sel", i === selectedIndex));
    listEl.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  function onInputKeydown(e) {
    // Bubble-phase guard for listeners on ancestors of the host (slotted input
    // already fixes retargeted capture listeners on document).
    e.stopPropagation();
    if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const entry = filtered[selectedIndex];
      if (entry) openEntry(entry, e.ctrlKey || e.metaKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeOverlay();
    }
  }

  function openEntry(entry, newTab) {
    closeOverlay();
    if (newTab) window.open(entry.url, "_blank");
    else location.assign(entry.url);
  }

  function openOverlay() {
    if (host) return;
    buildOverlay();
    renderList();
    inputEl.focus();
  }

  function closeOverlay() {
    host?.remove();
    host = null;
    root = null;
    inputEl = null;
    listEl = null;
  }

  // --- global navbar button -------------------------------------------------

  function toggleOverlay() {
    if (host) closeOverlay();
    else openOverlay();
  }

  function removeNavButton() {
    document.querySelectorAll(`[${NAV_MARK}]`).forEach((el) => el.remove());
  }

  function ensureNavButton() {
    if (document.querySelector(`[${NAV_MARK}]`)) return;
    const anchor = document.querySelector(NAV_ANCHOR);
    if (!anchor) return;
    const anchorWrap = anchor.parentElement;
    if (!anchorWrap?.parentElement) return;

    const btn = document.createElement("button");
    btn.className = anchor.className;
    btn.setAttribute("type", "button");
    const color = anchor.getAttribute("color");
    if (color) btn.setAttribute("color", color);
    btn.setAttribute("aria-label", "Search apps and tables");
    btn.innerHTML = NAV_SEARCH_SVG;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleOverlay();
    });

    const wrap = document.createElement(anchorWrap.tagName);
    for (const { name, value } of anchorWrap.attributes) {
      wrap.setAttribute(name, value);
    }
    wrap.setAttribute(NAV_MARK, "true");
    wrap.appendChild(btn);
    anchorWrap.parentElement.insertBefore(wrap, anchorWrap);
  }

  const navObserver = addedNodesObserver(NAV_ANCHOR, ensureNavButton);

  function startNavButton() {
    ensureNavButton();
    navObserver.start();
  }

  function stopNavButton() {
    navObserver.stop();
    removeNavButton();
  }

  // --- hotkey ---------------------------------------------------------------

  // Use the platform-native command modifier: ⌘ on Mac, Ctrl elsewhere
  // (mirrors context-menu-copy-cut.js's isMacLike()).
  const MAC = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

  function onKeydown(e) {
    const primary = MAC ? e.metaKey : e.ctrlKey;
    const wrongMod = MAC ? e.ctrlKey : e.metaKey;
    if (e.key.toLowerCase() === "k" && primary && !wrongMod && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopPropagation();
      toggleOverlay();
    }
  }

  // --- enable / revert ------------------------------------------------------

  function start() {
    window.addEventListener("keydown", onKeydown, true);
    startRecorder();
    startNavButton();
  }

  function stop() {
    window.removeEventListener("keydown", onKeydown, true);
    stopRecorder();
    stopNavButton();
    closeOverlay();
  }

  async function syncFromStorage() {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    let next;
    try {
      const { [TOGGLES_KEY]: stored = {} } = await local.get(TOGGLES_KEY);
      next = stored[FEATURE_ID] === true;
    } catch (err) {
      if (isContextInvalidatedError(err)) return stop();
      throw err;
    }
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      await loadHistory();
      start();
    } else {
      stop();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[TOGGLES_KEY]) syncFromStorage();
    else if (changes[HISTORY_KEY] && enabled) loadHistory();
  });

  syncFromStorage();
})();
