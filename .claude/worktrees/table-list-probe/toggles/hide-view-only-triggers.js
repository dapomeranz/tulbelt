// Hides base-layout trigger rows in the app editor's trigger list.
// Inherited layout triggers are view-only (lock icon, no row actions). App
// triggers can also be view-only but expose copy/view buttons — keep those.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "hide-view-only-triggers";
  const STYLE_ID = "tulbelt-hide-view-only-triggers-styles";

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(
        STYLE_ID,
        `[class*="triggerRowStyles"].view-only:not(:has([data-testid^="view-trigger-"])) { display: none !important; }`,
      );
    },
    onDisable() {
      removeStyles(STYLE_ID);
    },
  });
})();
