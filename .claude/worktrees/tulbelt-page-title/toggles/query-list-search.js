// The query picker popper (opened from a Query button) lists every saved query
// as a column of buttons. On apps with many queries it grows taller than the
// viewport, pushing the lower entries off-screen, and there's no way to find
// one by name. This caps the popper to the available screen height (the list
// scrolls inside) and adds a sticky search box at the top that filters the
// query buttons by substring as you type.
//
// The popper is portal-mounted lazily on open and its styled-components class
// names are hashed/unstable, so — the app-menu-recents-favorites.js pattern —
// we watch document.body for a popper to appear and identify the query one by
// content: it holds a button labelled "Create New Query". That button's parent
// is the flex column we cap, scroll, and filter. We never reparent Tulip's
// React-rendered buttons (that throws on later reconciliation); we only insert
// our own input as the first child, hide non-matching buttons inline, and set
// max-height/overflow on the container. The popper is transient, so reverting
// the currently-open one plus stopping the observer fully cleans up.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "query-list-search";

  const POPPER_SEL = '[x-attr-popper="popper"], [data-testid="popper"]';
  const CREATE_LABEL = "Create New Query";

  const CONTAINER_ATTR = "data-tulbelt-qls"; // the flex column we own
  const INPUT_ATTR = "data-tulbelt-qls-input"; // our search input
  const HIDDEN_ATTR = "data-tulbelt-qls-hidden"; // buttons we filtered out
  const TITLE_ATTR = "data-tulbelt-qls-title"; // buttons we gave a hover title
  const STYLE_ID = "tulbelt-qls-styles";
  const WIDTH = "280px"; // fixed column width

  let observer = null;

  // Readable font size + spacing for the query buttons. Tulip shrinks the font
  // to cram every query in; with the list scrollable we don't need that. A
  // stylesheet (vs. per-button inline styles) reverts in one removal and covers
  // buttons added after we process. The buttons carry several styled-component
  // classes, so !important is needed to win specificity.
  // The column is flex; without this the buttons shrink to fit the capped
  // height (vertically tightened, no scrollbar) instead of overflowing.
  // Fixed column width: long query names truncate with an ellipsis rather
  // than widening the popper. Hovering shows the full name (title attr).
  const CSS = `[${CONTAINER_ATTR}="1"] > button { font-size: 14px !important; margin-bottom: 6px !important; flex-shrink: 0 !important; max-width: 100% !important; box-sizing: border-box !important; overflow: hidden !important; white-space: nowrap !important; text-overflow: ellipsis !important; }`;

  // Among open poppers, return the query picker's button column (the parent of
  // the "Create New Query" button), or null if no query popper is open yet.
  function findQueryContainer() {
    for (const popper of document.querySelectorAll(POPPER_SEL)) {
      for (const btn of popper.querySelectorAll("button")) {
        if (btn.textContent.trim() === CREATE_LABEL) return btn.parentElement;
      }
    }
    return null;
  }

  // Hide query buttons whose label doesn't contain the search text. The
  // "Create New Query" action is never filtered.
  function filter(container, rawQuery) {
    const query = rawQuery.trim().toLowerCase();
    for (const btn of container.querySelectorAll(":scope > button")) {
      if (btn.textContent.trim() === CREATE_LABEL) continue;
      const match = !query || btn.textContent.toLowerCase().includes(query);
      if (match) {
        btn.style.removeProperty("display");
        btn.removeAttribute(HIDDEN_ATTR);
      } else {
        btn.style.setProperty("display", "none", "important");
        btn.setAttribute(HIDDEN_ATTR, "1");
      }
    }
  }

  function buildInput() {
    const input = document.createElement("input");
    input.setAttribute(INPUT_ATTR, "1");
    input.type = "text";
    input.placeholder = "Search queries…";
    input.style.cssText = [
      "position: sticky",
      "top: 0",
      "z-index: 1",
      "box-sizing: border-box",
      "flex-shrink: 0",
      "width: 100%",
      "margin: 0 0 6px",
      "padding: 6px 8px",
      "border: 1px solid #c7ced6",
      "border-radius: 4px",
      "font: inherit",
      "background: #fff",
      "color: #0f1c2c",
    ].join(";");
    // Keep keystrokes out of the popper's own type-ahead/navigation handlers so
    // typing filters our list instead of jumping the button focus. Escape still
    // bubbles so it can close the popper.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") e.stopPropagation();
    });
    return input;
  }

  function process(container) {
    if (container.getAttribute(CONTAINER_ATTR) === "1") return;
    container.setAttribute(CONTAINER_ATTR, "1");

    const input = buildInput();
    input.addEventListener("input", () => filter(container, input.value));
    container.insertBefore(input, container.firstChild);

    // Cap to 75% of the viewport so it fits on screen; the list scrolls inside.
    // Fix the width so long names truncate instead of widening the popper.
    container.style.maxHeight = "75vh";
    container.style.overflowY = "auto";
    container.style.width = WIDTH;

    input.focus();
  }

  // Give each query button a hover tooltip of its full label, so a name cut off
  // by the ellipsis can still be read. Idempotent per button (skips ones already
  // tagged) so it can re-run as buttons stream in after the popper mounts.
  function applyTitles(container) {
    for (const btn of container.querySelectorAll(":scope > button")) {
      if (btn.textContent.trim() === CREATE_LABEL) continue;
      if (btn.hasAttribute(TITLE_ATTR)) continue;
      btn.setAttribute("title", btn.textContent.trim());
      btn.setAttribute(TITLE_ATTR, "1");
    }
  }

  function restoreAll() {
    document.querySelectorAll(`[${INPUT_ATTR}]`).forEach((el) => el.remove());
    document.querySelectorAll(`[${HIDDEN_ATTR}]`).forEach((btn) => {
      btn.style.removeProperty("display");
      btn.removeAttribute(HIDDEN_ATTR);
    });
    document.querySelectorAll(`[${TITLE_ATTR}]`).forEach((btn) => {
      btn.removeAttribute("title");
      btn.removeAttribute(TITLE_ATTR);
    });
    document.querySelectorAll(`[${CONTAINER_ATTR}]`).forEach((c) => {
      c.style.removeProperty("max-height");
      c.style.removeProperty("overflow-y");
      c.style.removeProperty("width");
      c.removeAttribute(CONTAINER_ATTR);
    });
  }

  function applyToPresent() {
    const container = findQueryContainer();
    if (!container) return;
    process(container);
    applyTitles(container);
  }

  function onMutation(mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        // Match the popper itself, a wrapper containing it, OR a node added
        // inside an existing popper — the query buttons stream in after the
        // popper element mounts, so we must retry on those later insertions too.
        // Our own input insertion fires here as well; process() is idempotent.
        if (
          node.matches(POPPER_SEL) ||
          node.querySelector(POPPER_SEL) ||
          node.closest(POPPER_SEL)
        ) {
          applyToPresent();
          return;
        }
      }
    }
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
      ensureStyles(STYLE_ID, CSS);
      applyToPresent();
      startObserver();
    },
    onDisable() {
      stopObserver();
      restoreAll();
      removeStyles(STYLE_ID);
    },
  });
})();
