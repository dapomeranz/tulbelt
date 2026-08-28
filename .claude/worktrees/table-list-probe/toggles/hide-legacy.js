// Hides deprecated tiles in the app editor's right-side context pane. Each
// tile has the class `context-pane-tile`; we identify the ones to hide by the
// text of their first descendant <label>. Hidden via attribute + stylesheet
// so React reconciliation doesn't fight us.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const TILE_SELECTOR = ".context-pane-tile";
  const FEATURE_ID = "hide-legacy-tiles";
  const STYLE_ID = "tulbelt-hide-legacy-styles";
  const HIDE_ATTR = "data-tulbelt-hide-legacy";
  const LEGACY_LABELS = new Set([
    "Step cycle time",
    "Step comments",
    "Process cycle time",
    "App comments",
    "Step ID",
  ]);

  function tileLabel(tile) {
    return tile.querySelector("label")?.textContent?.trim() ?? "";
  }

  function applyToAll() {
    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      if (tile.getAttribute(HIDE_ATTR) === "true") continue;
      if (LEGACY_LABELS.has(tileLabel(tile))) {
        tile.setAttribute(HIDE_ATTR, "true");
      }
    }
  }

  function restoreAll() {
    for (const tile of document.querySelectorAll(`[${HIDE_ATTR}="true"]`)) {
      tile.removeAttribute(HIDE_ATTR);
    }
  }

  const observer = addedNodesObserver(TILE_SELECTOR, applyToAll);

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, `[${HIDE_ATTR}="true"] { display: none !important; }`);
      applyToAll();
      observer.start();
    },
    onDisable() {
      observer.stop();
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
