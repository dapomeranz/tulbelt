// The Tulbelt page shell: one full-window panel reached from the account
// dropdown (the menu holding My profile / Sign out), which every user gets —
// unlike the account settings pages, which a restricted user can't open at
// all. That's why nothing here hangs off Tulip's settings sidebar.
//
// This file owns the chrome only — menu item, panel, Back bar, tab strip, and
// the fake-URL routing. The tabs themselves come from other toggles, which
// register through `window.__tulbeltPage`:
//
//   __tulbeltPage.register({
//     id: "data-queries",              // tab id; also the URL tail
//     label: "Data Queries",           // tab strip label
//     containerId: "tulbelt-dq-page",  // id set on the content div (for CSS)
//     order: 20,                       // tab strip position, ascending
//     mount(container) { ... },        // fill the content div
//     unmount() { ... },               // optional; called when the tab closes
//   });
//   __tulbeltPage.unregister("data-queries");
//
// Registration IS the enable signal — a page registers when its toggle turns
// on and unregisters when it turns off — so the shell has no toggle of its
// own. It appears once at least one page is registered and tears itself down
// when the last one leaves.
//
// The URL is set with history.pushState to /tulbelt/<tab>, which React Router
// never observes, so Tulip keeps rendering whatever it had underneath while we
// cover it. Nothing else in the app can be clicked while the panel is up, so
// Back (and Escape) is the only way out: it pops our own entry when we pushed
// one, and otherwise navigates somewhere real. A cold load of a fake URL works
// too; Tulip's router may redirect the unknown route out from under us for a
// moment, so we take the URL back for a short window after load.
//
(() => {
  const { ensureStyles, removeStyles } = window.__tulbeltLib;

  const BASE_PATH = "/tulbelt";
  const MENU_LI_ATTR = "data-tulbelt-page-menu-item";
  const STYLE_ID = "tulbelt-page-styles";
  const PANEL_ID = "tulbelt-page-panel";
  // What the browser tab reads while the panel is up.
  const PAGE_TITLE = "Tulbelt";
  // How long after a cold load we keep reclaiming the URL from Tulip's router.
  const COLD_LOAD_GUARD_MS = 5000;

  // Registered pages, kept sorted by `order` then `label`.
  const pages = [];

  let started = false;
  let active = false;
  let activeTabId = null;
  let observer = null;
  let scheduled = false;
  // Real Tulip path to fall back to when leaving the fake page.
  let lastRealPath = "/";
  // Set when the page cold-loaded on a fake URL; consumed on the first scan.
  let coldLoadWanted = false;
  let coldLoadGuardUntil = 0;
  // Whether we pushed a history entry for the fake URL — decides whether Back
  // can pop one or has to navigate somewhere real.
  let pushedEntry = false;
  // The document title from before we took it over, and the observer holding it.
  let savedTitle = null;
  let titleObserver = null;

  const normalizePath = (p) => p.replace(/\/+$/, "") || "/";
  const isFakePath = (p = location.pathname) => {
    const n = normalizePath(p);
    return n === BASE_PATH || n.startsWith(`${BASE_PATH}/`);
  };
  const firstPage = () => pages[0] || null;
  const pageById = (id) => pages.find((p) => p.id === id) || null;
  const currentPage = () => pageById(activeTabId) || firstPage();
  // Bare /tulbelt (or a tab whose toggle is off) lands on the first page.
  const pageForPath = (p = location.pathname) =>
    pages.find((page) => page.path === normalizePath(p)) || firstPage();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // ── Registry ────────────────────────────────────────────────────────────────

  function register(page) {
    if (!page?.id || typeof page.mount !== "function") return;
    unregister(page.id, { silent: true });
    pages.push({
      id: page.id,
      label: page.label || page.id,
      path: page.path || `${BASE_PATH}/${page.id}`,
      containerId: page.containerId || `tulbelt-page-${page.id}`,
      order: page.order ?? 100,
      mount: page.mount,
      unmount: page.unmount,
    });
    pages.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
    if (pages.length === 1) start();
    // Unconditional: start() is a no-op once started, and a page re-registering
    // has just torn its own container down and needs it rebuilt either way.
    syncPanel();
  }

  function unregister(id, { silent = false } = {}) {
    const i = pages.findIndex((p) => p.id === id);
    if (i === -1) return;
    // Tear the tab down before dropping it, so its unmount still sees the DOM.
    if (active && activeTabId === id) closeContainer();
    pages.splice(i, 1);
    if (silent) return;
    if (pages.length === 0) stop();
    else if (active) {
      // The open tab's toggle was just switched off. Fall back to the first
      // remaining tab and take the URL with us, so Back still pops honestly.
      if (!pageById(activeTabId)) {
        activeTabId = firstPage().id;
        history.replaceState(null, "", currentPage().path);
      }
      syncPanel();
    }
  }

  // ── Styles ──────────────────────────────────────────────────────────────────

  const CSS = `
      #${PANEL_ID} {
        position: fixed; inset: 0; z-index: 2147483000; display: flex; flex-direction: column;
        background: #fff; color: #1a1f28;
        font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      }
      #${PANEL_ID} .tbp-panel-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: #f6f8fb; }
      #${PANEL_ID} .tbp-panel-title { font-size: 1.15em; font-weight: 600; }
      #${PANEL_ID} .tbp-panel-brand { margin-left: auto; color: #788293; font-size: 0.85em; }
      #${PANEL_ID} .tbp-panel-back { font: inherit; padding: 6px 12px; border: 1px solid #d5dae2; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; }
      #${PANEL_ID} .tbp-panel-back:hover { border-color: #1c69e1; }
      #${PANEL_ID} .tbp-tabs { flex: 0 0 auto; display: flex; gap: 4px; padding: 0 16px; background: #f6f8fb; border-bottom: 1px solid #d5dae2; }
      #${PANEL_ID} .tbp-tab { font: inherit; padding: 8px 14px; border: none; border-bottom: 2px solid transparent; background: none; color: #45526b; cursor: pointer; }
      #${PANEL_ID} .tbp-tab:hover { color: #1c69e1; }
      #${PANEL_ID} .tbp-tab-on { color: #1c69e1; border-bottom-color: #1c69e1; font-weight: 600; }
      #${PANEL_ID} .tbp-content { flex: 1 1 auto; min-width: 0; overflow: auto; }
    `;

  // ── Title ───────────────────────────────────────────────────────────────────

  // /tulbelt/<tab> is a route Tulip's router doesn't know, so whatever it
  // renders underneath us titles the document "Not Found" — and that title is
  // what the browser tab shows, since our panel is the only thing visible.
  // Hold the title for as long as the panel is up, then give back what was
  // there.
  function applyTitle() {
    if (document.title !== PAGE_TITLE) document.title = PAGE_TITLE;
  }

  function claimTitle() {
    if (titleObserver) return;
    savedTitle = document.title;
    applyTitle();
    // The app rewrites (and sometimes replaces) the <title> element on its own
    // schedule, and it lives in <head> — which the panel observer doesn't watch
    // — so reassert on any head mutation. applyTitle writes only when the title
    // actually differs, so our own write doesn't feed the loop.
    titleObserver = new MutationObserver(applyTitle);
    titleObserver.observe(document.head, { childList: true, subtree: true, characterData: true });
  }

  function releaseTitle() {
    if (!titleObserver) return;
    titleObserver.disconnect();
    titleObserver = null;
    // Put the old title back only if ours is still the one showing; the app
    // retitles on its own once it renders a route it knows.
    if (document.title === PAGE_TITLE && savedTitle != null) document.title = savedTitle;
    savedTitle = null;
  }

  // ── Nav item ────────────────────────────────────────────────────────────────

  function findUserMenuUl() {
    return document.querySelector('li[data-testid="my-profile-menuitem"]')?.closest("ul") || null;
  }

  // The one entry point: an item in the account dropdown. The clone carries no
  // React fiber, so Tulip's delegated handlers never fire for it — the link is
  // entirely ours.
  function injectMenuLi() {
    const ul = findUserMenuUl();
    if (!ul || ul.querySelector(`li[${MENU_LI_ATTR}]`)) return;
    const landing = firstPage();
    if (!landing) return;
    const items = [...ul.children].filter((n) => n.tagName === "LI");
    const links = items.filter((n) => n.querySelector("a[href]"));
    const template = links[links.length - 1];
    if (!template) return;
    const li = template.cloneNode(true);
    li.setAttribute(MENU_LI_ATTR, "");
    li.setAttribute("data-testid", "tulbelt-menuitem");
    // `value` is how Tulip's menu identifies a row; ours must not impersonate
    // the one we cloned.
    li.removeAttribute("value");
    li.setAttribute("href", landing.path);
    const a = li.querySelector("a");
    a.setAttribute("href", landing.path);
    a.setAttribute("data-testid", "tulbelt");
    const label = a.querySelector("span") || a;
    label.textContent = "Tulbelt";
    a.addEventListener("click", onMenuLinkClick);
    // Above Sign out — the only row that is a button rather than a link.
    const signOut = items.find((n) => !n.querySelector("a[href]"));
    if (signOut) signOut.before(li);
    else ul.appendChild(li);
  }

  function removeMenuLi() {
    document.querySelector(`li[${MENU_LI_ATTR}]`)?.remove();
  }

  // ── Activate / deactivate ───────────────────────────────────────────────────

  function buildPanel() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const bar = el("div", "tbp-panel-bar");
    const back = el("button", "tbp-panel-back", "← Back");
    back.type = "button";
    back.title = "Leave Tulbelt and return to Tulip";
    back.addEventListener("click", goBack);
    bar.appendChild(back);
    bar.appendChild(el("span", "tbp-panel-title", "Tulbelt"));
    bar.appendChild(
      el("span", "tbp-panel-brand", "Browser extension — nothing here leaves this browser")
    );
    panel.appendChild(bar);

    const tabs = el("div", "tbp-tabs");
    tabs.setAttribute("role", "tablist");
    panel.appendChild(tabs);
    return panel;
  }

  // The tab strip is rebuilt from `pages` rather than patched, so a toggle
  // flipping while the panel is open just redraws it.
  // MUST stay idempotent. syncPanel() runs on every mutation batch, and the
  // observer watches our own panel too — so replacing the buttons here would
  // mutate, re-fire the observer, and replace them again every frame. Besides
  // burning a core, that makes the tabs unclickable: a click needs mousedown
  // and mouseup on the same node, and the node wouldn't survive between them.
  // Rebuild only when the set of pages actually changed; selection is applied
  // as attributes, which are not what the observer watches.
  function syncTabs(panel) {
    const tabs = panel.querySelector(".tbp-tabs");
    const signature = pages.map((p) => `${p.id}:${p.label}`).join(" ");
    if (tabs.dataset.signature !== signature) {
      tabs.dataset.signature = signature;
      tabs.textContent = "";
      // A lone tab is a label, not a choice — the Back bar already says Tulbelt.
      tabs.style.display = pages.length > 1 ? "" : "none";
      for (const page of pages) {
        const btn = el("button", "tbp-tab", page.label);
        btn.type = "button";
        btn.setAttribute("role", "tab");
        btn.dataset.tabId = page.id;
        btn.addEventListener("click", () => selectTab(page.id));
        tabs.appendChild(btn);
      }
    }
    for (const btn of tabs.querySelectorAll(".tbp-tab")) {
      const on = btn.dataset.tabId === activeTabId;
      btn.classList.toggle("tbp-tab-on", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    }
  }

  // Give the outgoing page a chance to drop listeners before its DOM goes.
  function closeContainer() {
    const panel = document.getElementById(PANEL_ID);
    const container = panel?.querySelector(".tbp-content");
    if (!container) return;
    const page = pageById(container.dataset.pageId);
    try {
      page?.unmount?.();
    } catch (_) {}
    container.remove();
  }

  function syncPanel() {
    if (!active) return;
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = buildPanel();
      document.body.appendChild(panel);
    }
    syncTabs(panel);

    const page = currentPage();
    if (!page) return;
    const existing = panel.querySelector(".tbp-content");
    if (existing?.dataset.pageId === page.id) return;
    closeContainer();
    const container = el("div", "tbp-content");
    container.id = page.containerId;
    container.dataset.pageId = page.id;
    panel.appendChild(container);
    page.mount(container);
  }

  function selectTab(id) {
    if (!pageById(id) || activeTabId === id) return;
    activeTabId = id;
    // replaceState, not push: Back should leave Tulbelt, not walk the tabs.
    history.replaceState(null, "", currentPage().path);
    syncPanel();
  }

  function activate() {
    if (active || pages.length === 0) return;
    if (!isFakePath()) lastRealPath = location.pathname;
    activeTabId = pageForPath().id;
    active = true;
    ensureStyles(STYLE_ID, CSS);
    claimTitle();
    syncPanel();
  }

  function deactivate({ restoreUrl }) {
    if (!active) return;
    closeContainer();
    active = false;
    releaseTitle();
    document.getElementById(PANEL_ID)?.remove();
    pushedEntry = false;
    if (restoreUrl && isFakePath()) history.replaceState(null, "", lastRealPath);
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  function pushFake(path) {
    history.pushState(null, "", path);
    pushedEntry = true;
  }

  // The menu item. This deliberately lets the click propagate so Tulip's popup
  // dismissal still sees it; the synthetic Escape is the fallback for builds
  // that only close on a keyed dismiss. Dispatched from the link, not document
  // — React delegates from its root container, so an event fired on document
  // never reaches the popup — and before activating, because our own Escape
  // handler bails while the page is closed. That ordering is what stops this
  // from immediately closing the page it's opening.
  function onMenuLinkClick(e) {
    e.preventDefault();
    if (active || pages.length === 0) return;
    e.currentTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    lastRealPath = isFakePath() ? lastRealPath : location.pathname;
    pushFake(firstPage().path);
    activate();
  }

  // The panel covers the window, so this is the only way out. Popping our own
  // entry is the honest route; a cold load onto the fake URL has none, so
  // leave for wherever Tulip last was (or the app root).
  function goBack() {
    if (pushedEntry) {
      history.back(); // popstate → deactivate
      return;
    }
    deactivate({ restoreUrl: false });
    location.assign(lastRealPath || "/");
  }

  function onKeyDown(e) {
    if (e.key !== "Escape" || !active) return;
    if (e.target instanceof Element && e.target.closest("input, textarea, select")) return;
    goBack();
  }

  function onPopState() {
    if (!started) return;
    if (isFakePath()) {
      // Back/forward between tabs, or onto the page from outside it.
      activeTabId = pageForPath()?.id ?? null;
      if (active) syncPanel();
      else activate();
    } else {
      deactivate({ restoreUrl: false });
    }
  }

  // ── Observer loop ───────────────────────────────────────────────────────────

  function ensure() {
    injectMenuLi();
    if (coldLoadWanted && !active) {
      coldLoadWanted = false;
      activate();
      return;
    }
    if (!active) return;
    // A cold load lands on a route Tulip doesn't know; its router may redirect
    // out from under us a moment later. Take the URL back — replaceState, so
    // the history we'd pop is untouched — and keep where it wanted to go as
    // the exit path.
    if (performance.now() < coldLoadGuardUntil && !isFakePath()) {
      lastRealPath = location.pathname;
      history.replaceState(null, "", currentPage().path);
    }
    syncPanel();
  }

  function scheduleEnsure() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      if (started) ensure();
    });
  }

  function start() {
    if (started) return;
    started = true;
    ensureStyles(STYLE_ID, CSS);
    coldLoadWanted = isFakePath();
    if (coldLoadWanted) {
      coldLoadGuardUntil = performance.now() + COLD_LOAD_GUARD_MS;
      // A late redirect usually arrives with a render, but don't rely on the
      // mutation that carries it being the last one.
      setTimeout(scheduleEnsure, 300);
      setTimeout(scheduleEnsure, 1500);
    }
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("popstate", onPopState);
    observer = new MutationObserver(scheduleEnsure);
    observer.observe(document.body, { childList: true, subtree: true });
    ensure();
  }

  function stop() {
    if (!started) return;
    started = false;
    observer?.disconnect();
    observer = null;
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("popstate", onPopState);
    deactivate({ restoreUrl: true });
    removeMenuLi();
    removeStyles(STYLE_ID);
  }

  window.__tulbeltPage = { register, unregister, BASE_PATH };
})();
