// TEMPORARY PROBE — trigger-editor dropdown investigation. RESTORE THE STUB
// BEFORE COMMITTING (docs/devtools.md). Captures the native lifecycle of every
// dropdown/input surface the four suspect toggles operate on, so a baseline
// run (all four off) can be diffed against one-toggle-on runs:
//   action-editor-frequent   → select[data-testid$="action-editor"]
//   option-sets-trigger      → datasource-selector / type + value specifiers
//   trigger-value-full-text  → input[aria-label="Value Picker"]
//   variable-full-path       → button[aria-label="Select new variable or array"]

(() => {
  // Surface selector -> capture-phase events worth recording on it.
  const SURFACES = [
    ['select[data-testid$="action-editor"]', ["change", "click", "focus", "blur"]],
    ['select[data-testid="datasource-selector"]', ["change", "click", "focus", "blur"]],
    ['select[data-testid="type-static-value-specifier"]', ["change", "click", "focus", "blur"]],
    ['input[data-testid="value-static-value-specifier"]', ["change", "focus", "blur"]],
    ['input[aria-label="Value Picker"]', ["change", "focus", "blur"]],
    ['button[aria-label="Select new variable or array"]', ["click"]],
  ];

  // Tulbelt-owned artifacts each suspect toggle plants; watching them proves
  // which toggle touched the DOM and exactly when.
  const ARTIFACTS =
    "[data-tulbelt-oss-proxy], [data-tulbelt-oss-real]," +
    " [data-tulbelt-frequent-proxy], [data-tulbelt-frequent-hidden]," +
    " [data-tulbelt-fulltext-proxy], [data-tulbelt-fulltext-hidden]," +
    " [data-tulbelt-vfp-patched]";

  const SNAP_STYLES = [
    "display",
    "visibility",
    "opacity",
    "position",
    "width",
    "height",
    "min-width",
    "max-width",
    "margin",
    "padding",
    "flex",
    "overflow",
    "z-index",
  ];

  function start() {
    const T = window.__tulbelt;
    T.log("probe", "armed", { path: location.pathname });

    // Timeline marker for the trigger editor opening/closing.
    T.watch('button[aria-label="Copy link to trigger"]');

    for (const [sel, events] of SURFACES) T.watch(sel, { events, attributes: true });
    T.watch(ARTIFACTS, { attributes: true });

    // Manual deep capture. Run __probeSnap("what looks wrong") in the DevTools
    // console (Tulbelt context) the moment a dropdown renders oddly: snapshots
    // rect/computed-styles/outerHTML of every surface + proxy on screen, then
    // a structural tree of each trigger unit row.
    window.__probeSnap = (label = "manual") => {
      T.log("probe:snap", label);
      const sels = SURFACES.map(([sel]) => sel).concat(ARTIFACTS.split(", "));
      for (const sel of sels) {
        document
          .querySelectorAll(sel)
          .forEach((el) => T.snapshot(el, { styles: SNAP_STYLES, htmlMax: 2500 }));
      }
      document.querySelectorAll('[class*="triggerUnitStyles"]').forEach((el, i) => {
        T.log("probe:unit", i);
        T.tree(el, 4);
      });
      return "snapped — now run __tulbelt.copy()";
    };
  }

  // dev-tools enablement is read from chrome.storage asynchronously; arm the
  // probe once the helpers actually report enabled (give up after ~10s).
  let tries = 0;
  const arm = setInterval(() => {
    if (window.__tulbelt?.enabled) {
      clearInterval(arm);
      start();
    } else if ((tries += 1) > 40) {
      clearInterval(arm);
    }
  }, 250);
})();
