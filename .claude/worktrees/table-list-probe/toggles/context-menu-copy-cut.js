// When the canvas/widget context menu (Delete / Move To Front / Move To Back)
// appears, render Copy / Cut rows above it that fire the matching shortcuts.
//
// Approach:
//   * Locate `nav.react-contextmenu` in any reachable document.
//   * Insert a SIBLING `<ul>` before the React-managed `<ul>`, inside the same
//     wrapper. React doesn't reconcile children it didn't render here, so our
//     rows survive without fighting commits.
//   * All node-shape checks use `nodeType` / `tagName` rather than `instanceof`
//     to stay correct when the script (loaded `all_frames`) operates on DOM
//     owned by a different window (different realm = different constructors).

(() => {
  const FEATURE_ID = "context-menu-copy-cut";
  const STORAGE_KEY = "toggles";
  const LIST_MARK = "data-tulbelt-cc-list";
  const ROW_MARK = "data-tulbelt-cc-row";
  const NAV_HOOK = "data-tulbelt-cc-nav";

  const DEBUG = false;
  function log(...args) {
    if (!DEBUG) return;
    try {
      console.log("[tulbelt:cm]", location.host + location.pathname, ...args);
    } catch (_) {}
  }

  let enabled = false;
  /** @type {MutationObserver | null} */
  let docObserver = null;
  /** @type {Set<MutationObserver>} */
  const navObservers = new Set();
  /** @type {Document[]} */
  let hookedDocs = [];
  let sweepHandle = null;

  // ---------- cross-realm safe shape checks ----------
  function isElement(n) {
    return !!n && typeof n === "object" && n.nodeType === 1;
  }
  function isDocFragment(n) {
    return !!n && typeof n === "object" && n.nodeType === 11 && !("host" in n);
  }
  function isShadowRoot(n) {
    return !!n && typeof n === "object" && n.nodeType === 11 && "host" in n;
  }
  function isUl(n) {
    return isElement(n) && n.tagName === "UL";
  }
  function isIframe(n) {
    return isElement(n) && n.tagName === "IFRAME";
  }

  // ---------- reachable documents ----------
  function documentsToScan() {
    /** @type {Document[]} */
    const out = [];
    const seen = new Set();
    const add = (d) => {
      if (!d || seen.has(d)) return;
      seen.add(d);
      out.push(d);
    };

    add(document);

    // Ancestor chain (top might block; each access is guarded).
    try {
      let w = window;
      for (let i = 0; i < 32 && w && w.parent && w !== w.parent; i++) {
        try {
          w = w.parent;
          add(w.document);
        } catch (_) {
          break;
        }
      }
    } catch (_) {}

    try {
      add(window.top.document);
    } catch (_) {}

    // Descendant frames from the highest doc we can see.
    function descend(w) {
      try {
        for (let i = 0; i < w.frames.length; i++) {
          try {
            const fw = w.frames[i];
            add(fw.document);
            descend(fw);
          } catch (_) {}
        }
      } catch (_) {}
    }
    try {
      descend(window.top);
    } catch (_) {
      try {
        descend(window);
      } catch (_) {}
    }

    return out;
  }

  // ---------- shortcut dispatch ----------
  function isMacLike() {
    return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
  }

  function focusEditorSurface() {
    for (const doc of documentsToScan()) {
      const target =
        doc.querySelector('#cssCanvas [data-testid="widget"]') ||
        doc.querySelector("#cssCanvas") ||
        doc.querySelector('[data-testid="widget"]');
      if (target) {
        try {
          if (target.tabIndex < 0) target.tabIndex = -1;
          target.focus?.({ preventScroll: true });
        } catch (_) {}
        return target;
      }
    }
    return null;
  }

  function dispatchShortcut(kind /* 'copy' | 'cut' */) {
    const key = kind === "copy" ? "c" : "x";
    const code = kind === "copy" ? "KeyC" : "KeyX";
    const mac = isMacLike();
    const base = {
      key,
      code,
      ctrlKey: !mac,
      metaKey: mac,
      shiftKey: false,
      altKey: false,
      bubbles: true,
      cancelable: true,
      composed: true,
    };

    const focused = focusEditorSurface();

    /** @type {(EventTarget | null)[]} */
    const targets = [];
    if (focused) targets.push(focused);
    for (const doc of documentsToScan()) {
      const cssCanvas = doc.querySelector("#cssCanvas");
      if (cssCanvas) targets.push(cssCanvas);
      if (doc.activeElement && doc.activeElement !== doc.body) {
        targets.push(doc.activeElement);
      }
      if (doc.body) targets.push(doc.body);
      if (doc.documentElement) targets.push(doc.documentElement);
      targets.push(doc);
      if (doc.defaultView) targets.push(doc.defaultView);
    }

    for (const type of ["keydown", "keyup"]) {
      for (const t of targets) {
        if (!t) continue;
        try {
          t.dispatchEvent(new KeyboardEvent(type, base));
        } catch (_) {}
      }
    }
  }

  // react-contextmenu auto-closes on outside-mousedown — but simulating that on
  // `body` also deselects the widget in Tulip's editor (it's an "empty-space"
  // click), which would leave nothing to copy/cut. Instead we use the library's
  // own hide event and a direct DOM fallback so the widget selection survives.
  function closeReactContextMenus() {
    for (const doc of documentsToScan()) {
      try {
        const view = doc.defaultView || window;
        view.dispatchEvent?.(new CustomEvent("react-contextmenu-hide"));
        doc.dispatchEvent(new CustomEvent("react-contextmenu-hide", { bubbles: true }));
      } catch (_) {}
    }
    for (const doc of documentsToScan()) {
      try {
        for (const nav of doc.querySelectorAll("nav.react-contextmenu--visible")) {
          nav.classList.remove("react-contextmenu--visible");
          nav.style.opacity = "0";
          nav.style.pointerEvents = "none";
        }
      } catch (_) {}
    }
  }

  // ---------- menu shape ----------
  function menuSignatureMatches(ul) {
    const text = ul.textContent || "";
    return (
      text.includes("Delete") && text.includes("Move To Front") && text.includes("Move To Back")
    );
  }

  function rowsWithButton(ul) {
    return [...ul.children].filter((ch) => isElement(ch) && ch.querySelector?.("button"));
  }

  function findTemplateRow(ul) {
    for (const row of ul.children) {
      if (!isElement(row)) continue;
      if (row.classList?.contains("react-contextmenu-item") && row.querySelector("button")) {
        return row;
      }
    }
    for (const row of ul.children) {
      if (isElement(row) && row.querySelector("button")) return row;
    }
    return null;
  }

  // ---------- row customization ----------
  // Material icon paths matching the existing menu's 24×24 viewBox.
  const ICON_PATHS = {
    copy: "M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z",
    cut: "M9.64 7.64c.23-.5.36-1.05.36-1.64 0-2.21-1.79-4-4-4S2 3.79 2 6s1.79 4 4 4c.59 0 1.14-.13 1.64-.36L10 12l-2.36 2.36C7.14 14.13 6.59 14 6 14c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4c0-.59-.13-1.14-.36-1.64L12 14l7 7h3v-1L9.64 7.64zM6 8c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm0 12c-1.1 0-2-.89-2-2s.9-2 2-2 2 .89 2 2-.9 2-2 2zm6-7.5c-.28 0-.5-.22-.5-.5s.22-.5.5-.5.5.22.5.5-.22.5-.5.5zM19 3l-6 6 2 2 7-7V3z",
  };

  function setRowIcon(left, kind) {
    if (!left) return;
    const svg = left.querySelector("svg");
    if (!svg) return;
    const path = svg.querySelector("path");
    if (!path) return;
    path.setAttribute("d", ICON_PATHS[kind] || "");
    // Defensive: strip any extra children that might shadow our path.
    for (const ch of [...svg.children]) {
      if (ch !== path) ch.remove();
    }
  }

  function customizeRow(clone, label, shortcutLabel, kind) {
    clone.setAttribute(ROW_MARK, kind);

    // strip any aria-describedby (the cloned tooltip target id is stale)
    for (const el of clone.querySelectorAll("[aria-describedby]")) {
      el.removeAttribute("aria-describedby");
    }

    const btn = clone.querySelector("button");
    if (!btn) return;

    const outer = btn.querySelector(":scope > div");
    const left = outer?.firstElementChild;
    const shortcutEl = outer?.lastElementChild;
    const labelSpan = left?.querySelector("span");

    setRowIcon(left, kind);
    if (labelSpan) labelSpan.textContent = label;
    if (shortcutEl && shortcutEl !== left && shortcutEl.parentElement === outer) {
      shortcutEl.textContent = shortcutLabel;
    }

    btn.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        log("row click ->", kind);

        closeReactContextMenus();
        focusEditorSurface();

        // Still inside the user-gesture window — execCommand here dispatches a
        // real `copy`/`cut` event with isTrusted=true, which is what most apps
        // (including ones that use the native clipboard) listen for.
        try {
          const ok = document.execCommand(kind);
          log("execCommand", kind, "->", ok);
        } catch (err) {
          log("execCommand error", err?.message || err);
        }

        // Then also fire the synthetic Ctrl+C / Ctrl+X keydown for any handler
        // that listens for the keyboard shortcut rather than the clipboard event.
        requestAnimationFrame(() => dispatchShortcut(kind));
      },
      true,
    );
  }

  // ---------- injection ----------
  function alreadyInjectedNearUl(ul) {
    const wrapper = ul.parentElement;
    if (!wrapper) return false;
    return !!wrapper.querySelector(":scope > [" + LIST_MARK + "]");
  }

  function tryInject(nav) {
    if (!enabled) return;
    if (!isElement(nav)) return;
    const ul = nav.querySelector("ul");
    if (!isUl(ul)) {
      log("skip: no ul in nav");
      return;
    }
    if (!menuSignatureMatches(ul)) {
      log("skip: signature mismatch", (ul.textContent || "").slice(0, 60));
      return;
    }
    const rows = rowsWithButton(ul);
    if (rows.length < 3) {
      log("skip: only", rows.length, "rows yet");
      return;
    }
    if (alreadyInjectedNearUl(ul)) {
      log("skip: already injected");
      return;
    }
    const wrapper = ul.parentElement;
    if (!wrapper) return;
    const template = findTemplateRow(ul);
    if (!template) {
      log("skip: no template row");
      return;
    }

    const ourList = ul.cloneNode(false); // shallow: keep class/attrs, no children
    ourList.setAttribute(LIST_MARK, "1");

    const copy = template.cloneNode(true);
    const cut = template.cloneNode(true);
    customizeRow(copy, "Copy", "Ctrl+C", "copy");
    customizeRow(cut, "Cut", "Ctrl+X", "cut");
    ourList.appendChild(copy);
    ourList.appendChild(cut);

    wrapper.insertBefore(ourList, ul);
    log("injected sibling list; wrapper children now:", wrapper.children.length);
  }

  function removeAllInjections() {
    for (const doc of documentsToScan()) {
      if (!doc?.documentElement) continue;
      try {
        doc.querySelectorAll("[" + LIST_MARK + "]").forEach((el) => el.remove());
        doc.querySelectorAll("[" + NAV_HOOK + "]").forEach((el) => el.removeAttribute(NAV_HOOK));
      } catch (_) {}
    }
  }

  // ---------- nav discovery + observation ----------
  function scanNavs(doc) {
    if (!doc?.documentElement) return;
    let navs = [];
    try {
      navs = [...doc.querySelectorAll("nav.react-contextmenu")];
    } catch (_) {}
    if (navs.length) log("scanNavs found", navs.length, "navs in", doc.location?.href || "(doc)");
    for (const nav of navs) {
      attachNavObserver(nav);
      tryInject(nav);
    }
  }

  function attachNavObserver(nav) {
    if (!enabled) return;
    if (!isElement(nav)) return;
    if (nav.getAttribute(NAV_HOOK) === "1") return;
    nav.setAttribute(NAV_HOOK, "1");

    const mo = new MutationObserver(() => tryInject(nav));
    try {
      mo.observe(nav, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class", "style"],
      });
      navObservers.add(mo);
      log("attached nav observer");
    } catch (e) {
      log("nav observer error", e?.message || e);
    }
  }

  function scanEverywhere() {
    for (const doc of documentsToScan()) scanNavs(doc);
  }

  // ---------- top-level mutation observer (catches nav add later) ----------
  function onDocMutation(records) {
    for (const r of records) {
      for (const n of r.addedNodes) {
        if (!isElement(n)) continue;
        // Newly inserted nav (or one inside an added subtree)?
        if (n.matches?.("nav.react-contextmenu")) {
          attachNavObserver(n);
          tryInject(n);
        }
        const found = n.querySelectorAll?.("nav.react-contextmenu");
        if (found?.length) {
          for (const nav of found) {
            attachNavObserver(nav);
            tryInject(nav);
          }
        }
        // Newly inserted iframe — hook its doc when ready.
        if (isIframe(n)) hookIframeWhenReady(n);
        n.querySelectorAll?.("iframe").forEach(hookIframeWhenReady);
      }
    }
  }

  function startDocObserver() {
    if (docObserver) return;
    docObserver = new MutationObserver(onDocMutation);
    for (const doc of documentsToScan()) {
      if (!doc?.documentElement) continue;
      try {
        docObserver.observe(doc.documentElement, { childList: true, subtree: true });
        log("observing doc", doc.location?.href || "(doc)");
      } catch (e) {
        log("observe error", e?.message || e);
      }
    }
  }

  function stopDocObserver() {
    docObserver?.disconnect();
    docObserver = null;
    for (const mo of navObservers) mo.disconnect();
    navObservers.clear();
  }

  function hookIframeWhenReady(iframe) {
    if (!isIframe(iframe)) return;
    const tryHook = () => {
      try {
        const idoc = iframe.contentDocument;
        if (!idoc?.documentElement) return;
        if (docObserver) {
          docObserver.observe(idoc.documentElement, { childList: true, subtree: true });
        }
        installGestureHooksOn(idoc);
        scanNavs(idoc);
      } catch (_) {}
    };
    iframe.addEventListener("load", tryHook);
    tryHook();
  }

  // ---------- gesture hooks ----------
  function onRightPointerDown(e) {
    if (e.button !== 2) return;
    // Schedule a few scans — the nav usually mounts after this event.
    scanEverywhere();
    requestAnimationFrame(scanEverywhere);
    for (const ms of [16, 50, 100, 200, 400]) setTimeout(scanEverywhere, ms);
  }
  function onContextMenu() {
    scanEverywhere();
    requestAnimationFrame(scanEverywhere);
    for (const ms of [16, 50, 100, 200, 400]) setTimeout(scanEverywhere, ms);
  }

  function installGestureHooksOn(doc) {
    if (!doc) return;
    if (hookedDocs.includes(doc)) return;
    hookedDocs.push(doc);
    doc.addEventListener("contextmenu", onContextMenu, true);
    doc.addEventListener("pointerdown", onRightPointerDown, true);
    log("gesture hooks attached");
  }

  function installGestureHooks() {
    for (const doc of documentsToScan()) installGestureHooksOn(doc);
  }

  function removeGestureHooks() {
    for (const doc of hookedDocs) {
      try {
        doc.removeEventListener("contextmenu", onContextMenu, true);
        doc.removeEventListener("pointerdown", onRightPointerDown, true);
      } catch (_) {}
    }
    hookedDocs = [];
  }

  // ---------- toggle ----------
  async function syncFromStorage() {
    let stored = {};
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      if (raw[STORAGE_KEY] && typeof raw[STORAGE_KEY] === "object") stored = raw[STORAGE_KEY];
    } catch (e) {
      log("storage read failed", e?.message || e);
    }
    const next = stored[FEATURE_ID] === true;
    log("syncFromStorage enabled=", next);
    if (next === enabled) return;
    enabled = next;
    if (enabled) {
      startDocObserver();
      installGestureHooks();
      scanEverywhere();
      sweepHandle = setInterval(() => {
        installGestureHooks();
        scanEverywhere();
      }, 1500);
    } else {
      if (sweepHandle) {
        clearInterval(sweepHandle);
        sweepHandle = null;
      }
      stopDocObserver();
      removeGestureHooks();
      removeAllInjections();
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
  });

  syncFromStorage();
})();
