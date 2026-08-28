// Isolated-world half. The real work happens in
// `app-list-date-columns-main.js` (loaded into the page's main world via the
// manifest's `world: "MAIN"` content_scripts entry), where the page's own
// `fetch`/XHR responses — which carry the apps' created/last-completed dates —
// are actually visible.
//
// This half:
//   * reads the feature toggle from chrome.storage,
//   * mirrors the toggle to `<html data-tulbelt-app-dates-enabled="true">`
//     (attribute removed when off), which the main-world script watches via
//     MutationObserver,
//   * keeps that attribute in sync as the toggle changes.

(() => {
  const { registerToggle } = window.__tulbeltLib;

  const FEATURE_ID = "app-list-date-columns";
  const ATTR = "data-tulbelt-app-dates-enabled";

  registerToggle(FEATURE_ID, {
    onEnable() {
      try {
        document.documentElement.setAttribute(ATTR, "true");
      } catch (_) {}
    },
    onDisable() {
      try {
        document.documentElement.removeAttribute(ATTR);
      } catch (_) {}
    },
  });
})();
