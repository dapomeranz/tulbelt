// Keeps the first data column in view when a table page scrolls sideways. Tulip
// already pins the ID column, but an ID alone rarely tells you which record a
// row is. The column is pinned beside it with position: sticky, so it needs to
// sit exactly one ID column in from the left. The ID column can be resized, so
// a ResizeObserver feeds its live width into a CSS variable rather than this
// assuming Tulip's default 200px.
//
// The same dynamic-table component renders the table widget inside apps, whose
// first column isn't pinned, and a widget's columns are the app author's to
// lay out. So a grid only qualifies on a table page, and only when Tulip has
// pinned its first column itself. The marker lives on the grid element, so it
// can't outlive that grid and leak onto another page.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "freeze-table-column";
  const STYLE_ID = "tulbelt-freeze-table-column-styles";
  const FROZEN_ATTR = "data-tulbelt-frozen-column";
  const OFFSET_VAR = "--tulbelt-frozen-column-left";
  const DEFAULT_OFFSET = "200px";
  const GRID = '[data-testid="dynamic-table"]';
  const FIRST_HEADER = `${GRID} [data-testid^="col-header-0-"]`;
  const TABLE_PAGE = /^(?:\/w\/[^/]+)?\/table\/[^/]+/;

  // z-index 1 on cells matches Tulip's own pinned ID cell. Headers stay on auto,
  // like its ID header: they're lifted as a row by their sticky parent.
  const CSS = `
    [${FROZEN_ATTR}] [data-testid^="col-header-1-"],
    [${FROZEN_ATTR}] [data-testid^="table-row-"] > [data-testid^="table-cell-row-"]:nth-child(2) {
      position: sticky;
      left: var(${OFFSET_VAR}, ${DEFAULT_OFFSET});
    }
    [${FROZEN_ATTR}] [data-testid^="table-row-"] > [data-testid^="table-cell-row-"]:nth-child(2) {
      z-index: 1;
    }
  `;

  let trackedHeader = null;
  let trackedGrid = null;

  const sizeObserver = new ResizeObserver(() => {
    trackedGrid?.style.setProperty(OFFSET_VAR, `${trackedHeader.offsetWidth}px`);
  });

  function release() {
    sizeObserver.disconnect();
    trackedGrid?.removeAttribute(FROZEN_ATTR);
    trackedGrid?.style.removeProperty(OFFSET_VAR);
    trackedGrid = null;
    trackedHeader = null;
  }

  function trackGrid() {
    if (!TABLE_PAGE.test(location.pathname)) return;
    const header = document.querySelector(FIRST_HEADER);
    if (!header || header === trackedHeader || header.style.position !== "sticky") return;
    release();
    trackedHeader = header;
    trackedGrid = header.closest(GRID);
    trackedGrid.setAttribute(FROZEN_ATTR, "");
    sizeObserver.observe(header);
  }

  const headerObserver = addedNodesObserver(FIRST_HEADER, trackGrid);

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, CSS);
      trackGrid();
      headerObserver.start();
    },
    onDisable() {
      headerObserver.stop();
      release();
      removeStyles(STYLE_ID);
    },
  });
})();
