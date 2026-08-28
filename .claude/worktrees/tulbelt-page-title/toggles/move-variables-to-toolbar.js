// Hides the Variables tile from the app editor's context pane and adds a
// stand-in Edit-variables button to the top toolbar. The toolbar button is
// present whenever the toolbar is, regardless of which context-pane tab is
// active. On click, if the original button isn't rendered, we first switch to
// the "App" tab — that's the only pane that mounts the variables tile — then
// click the real button once React renders it. The real button drives the
// modal; we never try to open it ourselves.

(() => {
  const { registerToggle, addedNodesObserver, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "move-variables-to-toolbar";
  const STYLE_ID = "tulbelt-move-variables-styles";
  const HIDE_ATTR = "data-tulbelt-move-variables";
  const CLONE_MARK = "data-tulbelt-variables-clone";
  const TILE_SELECTOR = ".context-pane-tile";
  const TILE_LABEL = "Variables";
  const SOURCE_BUTTON_SELECTOR = "#app-context-pane-variables";
  const TAB_SELECTOR = '[data-testid="context-pane-tab-process"]';
  const TOOLBAR_ANCHOR_SELECTORS = ["#app-editor-translation", "#app-editor-snapshot"];
  const TRANSLATION_DROPDOWN_SELECTOR = '[data-testid="translationTargetLocalDropdown"]';
  const WAIT_FOR_SOURCE_MS = 2000;

  // Static copy of the variables glyph from the original button. Keeping it
  // inline lets us render the toolbar clone even when the source button has
  // never been on the page in this session.
  const VARIABLES_SVG = `<svg width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path d="M13.46,7.93c.35-.7,1.68-4.06,4.24-4.06a2.11,2.11,0,0,1,2.3,2,1.66,1.66,0,0,1-1.5,1.86c-.8,0-1.33-.53-1.86-.53a3.76,3.76,0,0,0-2.56,3.44,2.43,2.43,0,0,0,.09.8c.44,1.86,2,5.92,3,5.92.35,0,.89-.26,1.15-.26.53,0,.62.7.62,1.06S17.35,19.51,15.67,20a6.72,6.72,0,0,1-1.24.17c-1.41,0-1.94-2.12-2.74-3.89-.35-.7-.71-.7-1-.17-.44.88-2,4.06-4.24,4.06C5.5,20.13,4,19.43,4,18a1.82,1.82,0,0,1,1.77-1.94c.79,0,1.24.53,1.77.53.79,0,2.56-2,2.56-3.63a4.44,4.44,0,0,0-.18-1.06c-.44-1.41-1.59-5.3-2.83-5.3C6.65,6.61,6.21,7,6,7c-.44-.18-.62-.88-.62-1.15C5.41,5.37,7,4.49,8.69,4a5.61,5.61,0,0,1,1.14-.17c1.42,0,2.13,2,2.83,3.89C12.75,8.2,13.1,8.64,13.46,7.93Z"></path></svg>`;

  function tileLabel(tile) {
    return tile.querySelector("label")?.textContent?.trim() ?? "";
  }

  function findVariablesTile() {
    for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
      if (tileLabel(tile) === TILE_LABEL) return tile;
    }
    return null;
  }

  function removeClone() {
    for (const clone of document.querySelectorAll(`[${CLONE_MARK}]`)) {
      clone.remove();
    }
  }

  function waitForElement(selector, timeoutMs) {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);
      const obs = new MutationObserver(() => {
        const el = document.querySelector(selector);
        if (el) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(el);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        resolve(null);
      }, timeoutMs);
    });
  }

  async function openVariables() {
    let source = document.querySelector(SOURCE_BUTTON_SELECTOR);
    if (!source) {
      // The variables tile only mounts under the App tab; switch tabs first so
      // React renders the button we want to click.
      const tab = document.querySelector(TAB_SELECTOR);
      if (!tab) return;
      tab.click();
      source = await waitForElement(SOURCE_BUTTON_SELECTOR, WAIT_FOR_SOURCE_MS);
    }
    source?.click();
  }

  function findToolbarAnchor() {
    for (const selector of TOOLBAR_ANCHOR_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return { el, mode: "wrapped" };
    }
    const translation = document.querySelector(TRANSLATION_DROPDOWN_SELECTOR);
    if (translation) return { el: translation, mode: "after-translation" };
    return null;
  }

  function buildVariablesButton(anchor) {
    const btn = document.createElement("button");
    btn.className = anchor.className;
    btn.setAttribute("type", "button");
    const color = anchor.getAttribute("color");
    if (color) btn.setAttribute("color", color);
    // aria-label drives Tulip's tooltip content; "Variables" matches the
    // hidden tile's label so the affordance reads the same as before.
    btn.setAttribute("aria-label", "Variables");
    btn.innerHTML = VARIABLES_SVG;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openVariables();
    });
    return btn;
  }

  function ensureClone() {
    if (document.querySelector(`[${CLONE_MARK}]`)) return;
    const found = findToolbarAnchor();
    if (!found) return;
    const { el: anchor, mode } = found;
    const btn = buildVariablesButton(anchor);

    if (mode === "after-translation") {
      // Newer toolbars expose translation as a bare button (no sibling wrap).
      const templateWrap =
        document.querySelector("#app-editor-snapshot")?.parentElement ||
        anchor.parentElement?.querySelector("[data-istarget]");
      const wrap = document.createElement(templateWrap?.tagName || "div");
      if (templateWrap) {
        for (const { name, value } of templateWrap.attributes) {
          wrap.setAttribute(name, value);
        }
      }
      wrap.setAttribute(CLONE_MARK, "true");
      wrap.setAttribute("data-istarget", "true");
      wrap.appendChild(btn);
      anchor.insertAdjacentElement("afterend", wrap);
      return;
    }

    const anchorWrap = anchor.parentElement;
    if (!anchorWrap?.parentElement) return;

    // Mirror the neighboring wrapper + button so spacing, styled-component class
    // hashes, and Tulip's tooltip hook-ups (data-istarget) all carry over.
    const wrap = document.createElement(anchorWrap.tagName);
    for (const { name, value } of anchorWrap.attributes) {
      wrap.setAttribute(name, value);
    }
    wrap.setAttribute(CLONE_MARK, "true");
    wrap.appendChild(btn);
    anchorWrap.parentElement.insertBefore(wrap, anchorWrap);
  }

  function applyToTile() {
    const tile = findVariablesTile();
    if (!tile) return;
    if (tile.getAttribute(HIDE_ATTR) !== "true") {
      tile.setAttribute(HIDE_ATTR, "true");
    }
  }

  function restoreTile() {
    for (const tile of document.querySelectorAll(`[${HIDE_ATTR}="true"]`)) {
      tile.removeAttribute(HIDE_ATTR);
    }
  }

  function apply() {
    applyToTile();
    ensureClone();
  }

  const OBSERVED_SELECTOR = [
    TILE_SELECTOR,
    TRANSLATION_DROPDOWN_SELECTOR,
    ...TOOLBAR_ANCHOR_SELECTORS,
  ].join(", ");

  const observer = addedNodesObserver(OBSERVED_SELECTOR, apply);

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, `[${HIDE_ATTR}="true"] { display: none !important; }`);
      apply();
      observer.start();
    },
    onDisable() {
      observer.stop();
      removeClone();
      restoreTile();
      removeStyles(STYLE_ID);
    },
  });
})();
