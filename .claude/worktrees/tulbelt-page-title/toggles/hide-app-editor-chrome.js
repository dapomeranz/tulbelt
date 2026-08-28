// Hides editor chrome only on app version editor URLs (`/w/…/apps/…/versions/…` or `/apps/…/versions/…`):
// `[data-testid="tulip-header"]`, subheader row, and Add/Icons palette strip.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "hide-app-editor-chrome";
  const STYLE_ID = "tulbelt-hide-app-editor-chrome-styles";
  const MARK = "data-tulbelt-hide-app-editor-chrome";
  /** App version editor: /w/<ws>/apps/<appId>/versions/<versionId> or /apps/<appId>/versions/<versionId> */
  const APP_EDITOR_PATH_RE = /^(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\/[^/]+/;

  let active = false;

  function isAppEditorUrl() {
    return APP_EDITOR_PATH_RE.test(location.pathname || "");
  }

  function installHistoryLocationHooks() {
    window.addEventListener("popstate", () => queueMicrotask(onLocationMaybeChanged));
    window.addEventListener("tulbelt:navigate", () => queueMicrotask(onLocationMaybeChanged));
    if (window.__tulbeltHistoryHooked) return;
    window.__tulbeltHistoryHooked = true;
    const { pushState, replaceState } = history;
    history.pushState = function patchedPushState(...args) {
      const r = pushState.apply(this, args);
      window.dispatchEvent(new CustomEvent("tulbelt:navigate"));
      return r;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const r = replaceState.apply(this, args);
      window.dispatchEvent(new CustomEvent("tulbelt:navigate"));
      return r;
    };
  }

  installHistoryLocationHooks();

  function markSubheaderRow() {
    const subheader = document.querySelector('[data-testid="subheader"]');
    const row = subheader?.parentElement;
    if (!row || row === document.body || row === document.documentElement) return;
    // Same row also mounts Run/Publish; avoids hiding unrelated subheaders.
    if (!row.querySelector("#app-editor-publish")) return;
    row.setAttribute(MARK, "true");
  }

  function markPaletteRow() {
    const add = document.querySelector("#app-editor-add");
    const row = add?.parentElement;
    if (!row || row === document.body || row === document.documentElement) return;
    if (!row.querySelector("#app-editor-icons")) return;
    row.setAttribute(MARK, "true");
  }

  function markTulipHeader() {
    const header = document.querySelector('[data-testid="tulip-header"]');
    if (!header) return;
    header.setAttribute(MARK, "true");
  }

  function applyAll() {
    if (!isAppEditorUrl()) {
      restoreAll();
      return;
    }
    markTulipHeader();
    markSubheaderRow();
    markPaletteRow();
  }

  function onLocationMaybeChanged() {
    if (!active) return;
    applyAll();
  }

  function restoreAll() {
    for (const el of document.querySelectorAll(`[${MARK}="true"]`)) {
      el.removeAttribute(MARK);
    }
  }

  const CHROME_SELECTOR = [
    '[data-testid="tulip-header"]',
    '[data-testid="subheader"]',
    "#app-editor-add",
    "#app-editor-publish",
    "#app-editor-icons",
  ].join(", ");

  const observer = addedNodesObserver(CHROME_SELECTOR, applyAll);

  registerToggle(FEATURE_ID, {
    onEnable() {
      active = true;
      ensureStyles(STYLE_ID, `[${MARK}="true"] { display: none !important; }`);
      applyAll();
      observer.start();
    },
    onDisable() {
      active = false;
      observer.stop();
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
