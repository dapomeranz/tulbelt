// Visually moves the last two cells (edit + action menu) next to the name
// cell on tulip.co app/folder list rows. Uses CSS `order` rather than moving
// DOM nodes so React reconciliation doesn't fight us. Column widths are
// permuted via inline grid-template-columns so the action buttons keep their
// 44px slots.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const ROW_SELECTOR = '[role="row"][widths]';
  const ACTION_MENU_SELECTOR = '[data-testid="app-actions-menu"]';
  const FEATURE_ID = "reorder-row-buttons";
  const STYLE_ID = "tulbelt-reorder-styles";
  const REORDER_ATTR = "data-tulbelt-reorder";

  const knownBodyWidths = new Set();

  // Middle cells default to a high order; first cell stays first and the last
  // two are pulled forward into slots 2 and 3.
  const CSS = `
    [${REORDER_ATTR}="true"] > * { order: 5; }
    [${REORDER_ATTR}="true"] > :first-child { order: 1; }
    [${REORDER_ATTR}="true"] > :nth-last-child(2) { order: 2; }
    [${REORDER_ATTR}="true"] > :last-child { order: 3; }
  `;

  // Splits a grid-template-columns–style string on top-level whitespace, so
  // `minmax(300px, 1fr) 44px` becomes ["minmax(300px, 1fr)", "44px"].
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

  function isBodyRow(row) {
    return !!row.querySelector(ACTION_MENU_SELECTOR);
  }

  function reorderRow(row) {
    const widthsAttr = row.getAttribute("widths") || "";
    // Skip only if we already reordered this row from the *same* widths
    // signature. React reuses row nodes (notably the header) across view
    // changes and rewrites `widths` in place; without this check a stale
    // grid-template-columns would survive and misalign the row.
    if (row.getAttribute(REORDER_ATTR) === "true" && row.dataset.tulbeltReorderSrc === widthsAttr) {
      return;
    }
    const widths = splitTrackList(widthsAttr);
    if (widths.length < 4) return;

    if (isBodyRow(row)) {
      knownBodyWidths.add(widthsAttr);
    } else if (!knownBodyWidths.has(widthsAttr)) {
      // Not a body row and not matching one we've seen — skip (likely an
      // unrelated table or the header rendered before any body row).
      return;
    }

    const reordered = [
      widths[0],
      widths[widths.length - 2],
      widths[widths.length - 1],
      ...widths.slice(1, -2),
    ];
    row.style.setProperty("grid-template-columns", reordered.join(" "), "important");
    row.setAttribute(REORDER_ATTR, "true");
    row.dataset.tulbeltReorderSrc = widthsAttr;
  }

  function restoreRow(row) {
    row.style.removeProperty("grid-template-columns");
    row.removeAttribute(REORDER_ATTR);
    delete row.dataset.tulbeltReorderSrc;
  }

  function applyToAll() {
    const rows = document.querySelectorAll(ROW_SELECTOR);
    // First pass collects widths signatures from body rows, second pass picks
    // up matching header rows whose action menu is absent.
    for (const row of rows) if (isBodyRow(row)) reorderRow(row);
    for (const row of rows) reorderRow(row);
  }

  function restoreAll() {
    for (const row of document.querySelectorAll(`[${REORDER_ATTR}="true"]`)) {
      restoreRow(row);
    }
    knownBodyWidths.clear();
  }

  const observer = addedNodesObserver(ROW_SELECTOR, applyToAll);

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, CSS);
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
