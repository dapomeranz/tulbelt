// On app version editor pages (`/w/…/apps/…/versions/…` or `/apps/…/versions/…`),
// turns each row of the Tables tile in the right context pane into a
// tree-view item: a caret at the right edge of each row toggles its
// collapsed state. When collapsed, the row's Query / Record Placeholder /
// aggregation / linked record placeholder buttons are hidden, leaving just
// the icon, table name, and a two-line "· N placeholders" / "· M aggregations"
// summary visible (lines with a zero count are omitted); the summary is
// hidden when expanded. The table-name button keeps its original click
// behavior (open menu) — only the caret toggles. Default state is
// collapsed; each table is expanded independently.
//
// DOM landmarks (per a "*Standard Routing" example with a query, an
// aggregation, and two record placeholders):
//   .ixIsrx.kuWpdI                            table row (flex row)
//   ├── .dtKFZl.hGBTFd (firstChild)           DB icon container
//   ├── .dpeDVX.huAgIq                        content wrapper
//   │   ├── div[aria-haspopup="menu"]         table-name button (kept visible)
//   │   ├── div[data-testid="popper"]         table-name menu popper
//   │   ├── .jBOWzt.gTBAGM                    "Query" inline-add row
//   │   ├── .bYpYXe                           query sub-container
//   │   │   ├── span[id="<digits>"][aria-…]   query item       (NOT counted)
//   │   │   ├── div[aria-…] > button:no-title aggregation item (counted)
//   │   │   └── .eSGWx > button#add-agg-*     "Add Aggregation" button
//   │   ├── .lcHPRF.gTBAGM                    "Record Placeholder" inline-add
//   │   └── div[aria-haspopup="menu"]         record placeholder item (counted)
//   └── [data-tulbelt-tbl-caret] (inserted)   our caret button (flex pushed right)
//
// Implementation notes:
// - Table rows are anchored by `button[id^="add-query-"]` (Tulip's stable
//   per-table ID prefix); style-component class hashes are intentionally
//   avoided everywhere.
// - Item-type identification is structural, not class-based:
//     placeholder = `div[aria-haspopup="menu"] > button[title]`
//     aggregation = `div[aria-haspopup="menu"] > button:not([title]):not([id])`
//     query       = `span[aria-haspopup="menu"]` (excluded by the `div` prefix)
//   The inline "Add …" buttons all carry `aria-haspopup` on the `<button>`,
//   not the wrapping `<div>`, so a `div[aria-haspopup] > button` selector
//   cleanly skips them.
// - The caret is inserted as a real DOM element (last child of the row),
//   pushed to the right edge by the row's natural `display: flex` plus
//   `margin-left: auto`. We deliberately do NOT set `position: relative`
//   (or any other containing-block-establishing property) on the row:
//   Tulip's table-menu popper is rendered inside the row's content wrapper
//   and uses its containing block + clipping ancestors to compute its
//   placement boundary. Making the row a containing block causes the
//   popper to flip and shrink to fit inside the scrollable list, which
//   reads as a regression. Leaving the row static keeps the popper at body
//   level — same behavior as with this toggle off. The caret is a sibling
//   of the content wrapper, not an ancestor of the popper, so its presence
//   doesn't pull the popper into a smaller containing block.
// - The summary text is a CSS `::after` on the table-name div driven by a
//   data attribute and shown only when collapsed.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "collapse-tables-tile";
  const STYLE_ID = "tulbelt-collapse-tables-tile-styles";
  const APP_EDITOR_PATH_RE = /^(?:\/w\/[^/]+)?\/apps\/[^/]+\/versions\/[^/]+/;

  const ROW_ATTR = "data-tulbelt-tbl-row"; // "collapsed" | "expanded"
  const CONTENT_ATTR = "data-tulbelt-tbl-content"; // on the row content wrapper
  const NAME_ATTR = "data-tulbelt-tbl-name"; // on the table-name button div
  const COUNTS_ATTR = "data-tulbelt-tbl-counts"; // on the table-name div; CSS ::after reads it
  const CARET_ATTR = "data-tulbelt-tbl-caret"; // on the inserted caret element
  const TILE_ATTR = "data-tulbelt-tbl-tile"; // on the rows' shared parent (the Tables tile container)
  const ATTRS = [ROW_ATTR, CONTENT_ATTR, NAME_ATTR, COUNTS_ATTR, CARET_ATTR, TILE_ATTR];

  let active = false;
  let observer = null;
  let applyScheduled = false;

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

  const CSS = `
[${TILE_ATTR}="true"] {
  overflow-x: clip;
}
[${CARET_ATTR}] {
  flex: 0 0 auto;
  align-self: flex-start;
  width: 24px;
  height: 24px;
  margin-top: 8px;
  margin-right: 8px;
  margin-left: auto;
  border-radius: 50%;
  background-color: transparent;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236b7280' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
  background-repeat: no-repeat;
  background-position: center;
  background-size: 14px 14px;
  cursor: pointer;
  transition: background-color 0.15s ease, transform 0.15s ease;
}
[${ROW_ATTR}="collapsed"] > [${CARET_ATTR}] {
  transform: rotate(-90deg);
}
[${CARET_ATTR}]:hover {
  background-color: rgba(15, 28, 44, 0.08);
}
/* The table-name button's menu (Tulip's table-menu popper) is rendered as a
   direct sibling of the name inside the content wrapper, so it would also
   match "everything but the name". Carve only that direct popper sibling
   out — the Query / Record Placeholder / aggregation / linked-record rows
   themselves each contain their own popper descendant, but we still want
   to hide those rows when collapsed (their popper menus only need to work
   once the row is expanded). */
[${ROW_ATTR}="collapsed"] > [${CONTENT_ATTR}="true"] > *:not([${NAME_ATTR}="true"]):not([data-testid="popper"]) {
  display: none !important;
}
[${NAME_ATTR}="true"] {
  min-width: 0;
  box-sizing: border-box;
}
[${NAME_ATTR}="true"] > button {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[${ROW_ATTR}="collapsed"] > [${CONTENT_ATTR}="true"] > [${NAME_ATTR}="true"][${COUNTS_ATTR}] {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
[${ROW_ATTR}="collapsed"] > [${CONTENT_ATTR}="true"] > [${NAME_ATTR}="true"][${COUNTS_ATTR}]::after {
  content: attr(${COUNTS_ATTR});
  margin-top: 2px;
  color: #6b7280;
  font-size: 0.85em;
  font-weight: normal;
  pointer-events: none;
  white-space: pre-line;
}`;

  function countPlaceholders(content) {
    return content.querySelectorAll(`div[aria-haspopup="menu"]:not([${NAME_ATTR}]) > button[title]`)
      .length;
  }

  function countAggregations(content) {
    // Aggregation buttons have no `title` (text is in a nested div) and no `id`
    // (the inline "Add Aggregation" button has `id="add-agg-…"`).
    return content.querySelectorAll('div[aria-haspopup="menu"] > button:not([title]):not([id])')
      .length;
  }

  function buildCountsLabel(placeholders, aggregations) {
    const parts = [];
    if (placeholders > 0) {
      parts.push(`· ${placeholders} placeholder${placeholders === 1 ? "" : "s"}`);
    }
    if (aggregations > 0) {
      parts.push(`· ${aggregations} aggregation${aggregations === 1 ? "" : "s"}`);
    }
    // Newline-separated; CSS `white-space: pre-line` on the ::after renders
    // each part on its own line.
    return parts.join("\n");
  }

  function updateCountsFor(content) {
    const nameDiv = content.querySelector(`:scope > [${NAME_ATTR}="true"]`);
    if (!nameDiv) return;
    const label = buildCountsLabel(countPlaceholders(content), countAggregations(content));
    if (label) {
      if (nameDiv.getAttribute(COUNTS_ATTR) !== label) {
        nameDiv.setAttribute(COUNTS_ATTR, label);
      }
    } else if (nameDiv.hasAttribute(COUNTS_ATTR)) {
      nameDiv.removeAttribute(COUNTS_ATTR);
    }
  }

  function ensureCaret(row) {
    // Caret must be the last child of the row so `margin-left: auto` pushes
    // it to the right edge. If React re-rendered the row's children and
    // either removed our caret or inserted something after it, fix that up.
    let caret = row.querySelector(`:scope > [${CARET_ATTR}]`);
    if (!caret) {
      caret = document.createElement("div");
      caret.setAttribute(CARET_ATTR, "true");
      caret.setAttribute("role", "button");
      caret.setAttribute("aria-label", "Toggle table row");
      row.appendChild(caret);
    } else if (caret !== row.lastElementChild) {
      row.appendChild(caret);
    }
  }

  function applyAll() {
    if (!isAppEditorUrl()) {
      restoreAll();
      return;
    }
    const queryButtons = document.querySelectorAll('button[id^="add-query-"]');
    for (const qb of queryButtons) {
      const queryRow = qb.parentElement; // .gTBAGM Query inline row
      const content = queryRow?.parentElement; // table-row content wrapper
      const row = content?.parentElement; // table row
      if (!row || !content) continue;

      if (!row.hasAttribute(ROW_ATTR)) {
        // The first `[aria-haspopup="menu"]` child of the content wrapper is
        // the table-name button — that's what stays visible when collapsed.
        // Linked record buttons share the same aria attribute but come later
        // in the child order, so `:scope > [aria-haspopup="menu"]` picks the
        // right one.
        const nameBtn = content.querySelector(':scope > [aria-haspopup="menu"]');
        if (!nameBtn) continue;

        content.setAttribute(CONTENT_ATTR, "true");
        nameBtn.setAttribute(NAME_ATTR, "true");
        row.setAttribute(ROW_ATTR, "collapsed");
      }

      const tile = row.parentElement;
      if (tile && !tile.hasAttribute(TILE_ATTR)) {
        tile.setAttribute(TILE_ATTR, "true");
      }

      ensureCaret(row);
      updateCountsFor(content);
    }
  }

  function restoreAll() {
    for (const caret of document.querySelectorAll(`[${CARET_ATTR}]`)) {
      caret.remove();
    }
    for (const attr of ATTRS) {
      for (const el of document.querySelectorAll(`[${attr}]`)) {
        el.removeAttribute(attr);
      }
    }
  }

  function onClick(e) {
    if (!active) return;
    const caret = e.target.closest?.(`[${CARET_ATTR}]`);
    if (!caret) return;
    const row = caret.closest(`[${ROW_ATTR}]`);
    if (!row) return;
    e.preventDefault();
    e.stopPropagation();
    row.setAttribute(
      ROW_ATTR,
      row.getAttribute(ROW_ATTR) === "collapsed" ? "expanded" : "collapsed",
    );
  }

  function scheduleApply() {
    if (applyScheduled) return;
    applyScheduled = true;
    requestAnimationFrame(() => {
      applyScheduled = false;
      applyAll();
    });
  }

  function mutationTouchesTarget(mutation) {
    // New table appearing OR placeholder/aggregation/query item added or
    // removed OR our caret got stripped by a React re-render. All three Tulip
    // item types carry `aria-haspopup="menu"`; new tables bring an
    // `add-query-*` button.
    for (const node of mutation.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.('button[id^="add-query-"]') ||
        node.querySelector?.('button[id^="add-query-"]') ||
        node.matches?.('[aria-haspopup="menu"]') ||
        node.querySelector?.('[aria-haspopup="menu"]')
      ) {
        return true;
      }
    }
    for (const node of mutation.removedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(`[${CARET_ATTR}]`) ||
        node.matches?.('[aria-haspopup="menu"]') ||
        node.querySelector?.('[aria-haspopup="menu"]')
      ) {
        return true;
      }
    }
    return false;
  }

  function onMutation(mutations) {
    for (const m of mutations) {
      if (mutationTouchesTarget(m)) {
        scheduleApply();
        return;
      }
    }
  }

  function onLocationMaybeChanged() {
    if (!active) return;
    applyAll();
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      active = true;
      ensureStyles(STYLE_ID, CSS);
      document.addEventListener("click", onClick, true);
      applyAll();
      startObserver();
    },
    onDisable() {
      active = false;
      stopObserver();
      document.removeEventListener("click", onClick, true);
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
