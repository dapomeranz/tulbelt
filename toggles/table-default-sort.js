// Isolated half of table-default-sort. The main-world half
// (table-default-sort-main.js) sorts tables opened from inside Tulip, but that
// world can't read chrome.storage, so this tells it whether the toggle is on
// with an attribute on <html>. Off, nothing more is sorted; the table already
// on screen keeps the order it has, as it did when this was a reload.

(() => {
  const { registerToggle } = window.__tulbeltLib;

  const FEATURE_ID = "table-default-sort";
  const ENABLED_ATTR = "data-tulbelt-table-sort-enabled";

  registerToggle(FEATURE_ID, {
    onEnable() {
      document.documentElement.setAttribute(ENABLED_ATTR, "true");
    },
    onDisable() {
      document.documentElement.removeAttribute(ENABLED_ATTR);
    },
  });
})();
