// In the trigger editor variable picker, nested Object fields are shown with
// only their leaf name after selection. This toggle rewrites the trigger
// button display to show the full ancestor path: "Parent → Child → Leaf".
//
// The dropdown is a virtualised list rendered in a portal (no DOM relationship
// to the trigger button that opened it). Hierarchy is encoded by indent depth:
// each nesting level adds two non-breaking spaces to a leading <span> inside
// the <button>. There may also be disabled <li> items acting as group headers
// (some apps use this pattern instead of indent-only).
//
// Two complementary behaviors:
// - Live patch: when the user clicks a nested item in an open dropdown, patch
//   the trigger button that opened it with the full path.
// - Auto-expand on open: when the trigger editor opens (detected via the
//   "Copy link to trigger" button appearing), run a one-time pass that briefly
//   opens each already-selected variable button to learn its full path and
//   rewrite its label. This catches variables selected before the toggle ran.

(() => {
  const { registerToggle } = window.__tulbeltLib;

  const FEATURE_ID = "variable-full-path";
  const STASH_ATTR = "data-tulbelt-vfp-original";
  const PATCHED_ATTR = "data-tulbelt-vfp-patched";
  const TRIGGER_BTN_LABEL = "Select new variable or array";
  const TRIGGER_BTN_SELECTOR = `button[aria-label="${TRIGGER_BTN_LABEL}"]`;
  const COPY_LINK_BTN_SELECTOR = 'button[aria-label="Copy link to trigger"]';
  const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';

  let enabled = false;
  let attached = false;
  let lastTriggerBtn = null;
  let observer = null;
  let expanding = false;
  let expandedThisOpen = false;

  // ---------------------------------------------------------------------------
  // Find the variable-picker scroll container (has <li> children)
  // ---------------------------------------------------------------------------
  function findVariableContainer() {
    for (const sc of document.querySelectorAll(SCROLL_CONTAINER_SELECTOR)) {
      if (sc.querySelector("li")) return sc;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Get indent level of an <li>: count leading whitespace/nbsp chars in the
  // first <span> inside its <button>. Returns 0 for no indent.
  // ---------------------------------------------------------------------------
  function indentLevel(li) {
    const firstSpan = li.querySelector("button > span:first-child");
    if (!firstSpan) return 0;
    const t = firstSpan.textContent;
    if (!/^[\s\u00a0]+$/.test(t)) return 0;
    // Each indent level = 2 chars (nbsp nbsp). Use length as proxy.
    return t.length;
  }

  // ---------------------------------------------------------------------------
  // Is this <li> selectable (not a disabled-only header with no indent)?
  // Both indented items AND top-level non-disabled items are selectable.
  // ---------------------------------------------------------------------------
  function isNested(li) {
    return indentLevel(li) > 0;
  }

  function itemLabel(li) {
    const btn = li.querySelector("button");
    return (
      btn?.getAttribute("aria-label") ||
      btn?.getAttribute("data-testid") ||
      btn?.textContent?.trim() ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // Build full path for a clicked <li> by walking backward through sorted rows
  // and collecting ancestors with strictly smaller indent levels.
  // ---------------------------------------------------------------------------
  function buildPath(clickedLi, scrollContainer) {
    const rows = [
      ...(scrollContainer.firstElementChild?.querySelectorAll(
        ':scope > div[style*="position: absolute"]',
      ) || []),
    ].sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top));

    // Find the clicked row index
    const clickedRow = clickedLi.parentElement;
    const clickedIdx = rows.findIndex((r) => r === clickedRow);
    if (clickedIdx < 0) return null;

    const clickedIndent = indentLevel(clickedLi);
    // Top-level item (indent 0) — no path needed
    if (clickedIndent === 0 && !clickedLi.hasAttribute("disabled")) return null;

    const path = [itemLabel(clickedLi)];
    let currentIndent = clickedIndent;

    // Walk backward to collect ancestors
    for (let i = clickedIdx - 1; i >= 0 && currentIndent > 0; i--) {
      const li = rows[i].querySelector("li");
      if (!li) continue;
      const indent = indentLevel(li);
      // Disabled items with no indent act as group headers
      const isHeader = li.hasAttribute("disabled") && indent === 0;
      if (indent < currentIndent || isHeader) {
        const label = itemLabel(li);
        if (label) path.unshift(label);
        currentIndent = isHeader ? 0 : indent;
      }
    }

    // Only rewrite if we actually found ancestors
    if (path.length <= 1) return null;
    return path.join(" → ");
  }

  // ---------------------------------------------------------------------------
  // Build full path for the currently-selected item in an open dropdown.
  // The selected row has aria-selected="true" on its button, matched by the
  // visible leaf name on the trigger button. Fallback: any row matching leaf.
  // ---------------------------------------------------------------------------
  function buildPathForSelected(scrollContainer, expectedLeafName) {
    const rows = [
      ...(scrollContainer.firstElementChild?.querySelectorAll(
        ':scope > div[style*="position: absolute"]',
      ) || []),
    ].sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top));

    // Find the row whose button matches the expected leaf and has aria-selected
    let selectedIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const li = rows[i].querySelector("li");
      const btn = li?.querySelector("button");
      if (!btn) continue;
      const ariaSel = btn.getAttribute("aria-selected");
      const label = itemLabel(li);
      if (ariaSel === "true" && label === expectedLeafName) {
        selectedIdx = i;
        break;
      }
    }
    // Fallback: any row with matching label
    if (selectedIdx < 0) {
      for (let i = 0; i < rows.length; i++) {
        const li = rows[i].querySelector("li");
        if (li?.hasAttribute("disabled")) continue;
        if (itemLabel(li) === expectedLeafName) {
          selectedIdx = i;
          break;
        }
      }
    }
    if (selectedIdx < 0) return null;

    const clickedLi = rows[selectedIdx].querySelector("li");
    const clickedIndent = indentLevel(clickedLi);
    if (clickedIndent === 0) return null; // top-level, no path

    const path = [itemLabel(clickedLi)];
    let currentIndent = clickedIndent;

    for (let i = selectedIdx - 1; i >= 0 && currentIndent > 0; i--) {
      const li = rows[i].querySelector("li");
      if (!li) continue;
      const indent = indentLevel(li);
      const isHeader = li.hasAttribute("disabled") && indent === 0;
      if (indent < currentIndent || isHeader) {
        const label = itemLabel(li);
        if (label) path.unshift(label);
        currentIndent = isHeader ? 0 : indent;
      }
    }

    return path.length > 1 ? path.join(" → ") : null;
  }

  // ---------------------------------------------------------------------------
  // Patch / restore the trigger button
  // ---------------------------------------------------------------------------
  function patchButton(btn, path) {
    if (!btn) return;
    // The visible label is inside a nested div, not a direct span[title].
    // Find the deepest text-bearing element that isn't an SVG.
    const labelEl = btn.querySelector("div > div > div > div") || btn.querySelector("div");
    const target = labelEl || btn;
    if (target.getAttribute(PATCHED_ATTR) === path) return;
    if (!target.hasAttribute(STASH_ATTR)) {
      target.setAttribute(STASH_ATTR, target.textContent);
    }
    target.setAttribute(PATCHED_ATTR, path);
    target.textContent = path;
  }

  function restoreAll() {
    for (const el of document.querySelectorAll(`[${STASH_ATTR}]`)) {
      el.textContent = el.getAttribute(STASH_ATTR);
      el.removeAttribute(STASH_ATTR);
      el.removeAttribute(PATCHED_ATTR);
    }
  }

  // Get the currently-visible leaf text of a variable trigger button.
  function getButtonLeafText(btn) {
    const labelEl = btn.querySelector("div > div > div > div") || btn.querySelector("div");
    return labelEl?.textContent?.trim() || null;
  }

  // Has this button already been patched (by live click or a previous pass)?
  function isPatched(btn) {
    const labelEl = btn.querySelector("div > div > div > div") || btn.querySelector("div");
    return labelEl?.hasAttribute(PATCHED_ATTR);
  }

  // ---------------------------------------------------------------------------
  // Click handler — live patch of items selected while the toggle is on
  // ---------------------------------------------------------------------------
  function handleClick(e) {
    if (!enabled) return;

    // Track which trigger button opened the dropdown
    const triggerBtn = e.target.closest(TRIGGER_BTN_SELECTOR);
    if (triggerBtn) {
      lastTriggerBtn = triggerBtn;
      return;
    }

    // Check if a nested field was clicked
    const btn = e.target.closest('button[data-istarget="true"]:not([disabled])');
    if (!btn) return;
    const li = btn.closest("li");
    if (!li || !isNested(li)) return;

    const scrollContainer = findVariableContainer();
    if (!scrollContainer?.contains(li)) return;

    const path = buildPath(li, scrollContainer);
    if (!path) return;

    const targetBtn = lastTriggerBtn;
    setTimeout(() => {
      if (targetBtn) patchButton(targetBtn, path);
    }, 80);
  }

  // ---------------------------------------------------------------------------
  // Auto-expand pass — open each already-selected variable to learn its path
  // ---------------------------------------------------------------------------
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitForContainer(timeoutMs = 800) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        const sc = findVariableContainer();
        if (sc) return resolve(sc);
        if (Date.now() - start > timeoutMs) return resolve(null);
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function waitForContainerGone(timeoutMs = 500) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (!findVariableContainer()) return resolve();
        if (Date.now() - start > timeoutMs) return resolve();
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  // Process one button: open dropdown, read selected path, close, patch.
  async function processButton(btn) {
    const leafName = getButtonLeafText(btn);
    if (!leafName || leafName === "" || leafName === TRIGGER_BTN_LABEL) return;

    // Open dropdown
    btn.click();
    const sc = await waitForContainer(800);
    if (!sc) return;

    // Build path for the selected item
    const path = buildPathForSelected(sc, leafName);

    // Close dropdown
    btn.click();
    await waitForContainerGone(500);

    if (path) patchButton(btn, path);
  }

  async function runExpand() {
    if (expanding) return;
    expanding = true;
    try {
      const candidates = [...document.querySelectorAll(TRIGGER_BTN_SELECTOR)].filter(
        (b) => !isPatched(b),
      );
      for (const candidate of candidates) {
        if (!enabled) break;
        try {
          await processButton(candidate);
        } catch (e) {
          // Don't let one bad button stop the run
          console.warn("[tulbelt variable-full-path] expand failed for button", e);
        }
        // Small breather so React can settle
        await sleep(60);
      }
    } finally {
      expanding = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Observer — detect trigger editor open/close and run the expand pass once
  // ---------------------------------------------------------------------------
  function onMutation() {
    if (!enabled) return;
    const editorOpen = !!document.querySelector(COPY_LINK_BTN_SELECTOR);
    if (editorOpen && !expandedThisOpen) {
      expandedThisOpen = true;
      // Give the variable buttons a beat to render before opening dropdowns.
      setTimeout(() => {
        if (enabled) runExpand();
      }, 300);
    } else if (!editorOpen) {
      // Editor closed — allow the next open to expand again.
      expandedThisOpen = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Enable / disable
  // ---------------------------------------------------------------------------
  function startObserver() {
    if (attached) return;
    document.addEventListener("click", handleClick, true);
    observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    attached = true;
    // Handle the case where the editor is already open when the toggle turns on.
    onMutation();
  }

  function stopObserver() {
    if (!attached) return;
    document.removeEventListener("click", handleClick, true);
    observer?.disconnect();
    observer = null;
    attached = false;
    lastTriggerBtn = null;
    expandedThisOpen = false;
  }

  // ---------------------------------------------------------------------------
  // Storage sync
  // ---------------------------------------------------------------------------
  // `enabled` is also read by handleClick/runExpand/onMutation, so mirror the
  // toggle state into it here.
  registerToggle(FEATURE_ID, {
    onEnable() {
      enabled = true;
      startObserver();
    },
    onDisable() {
      enabled = false;
      stopObserver();
      restoreAll();
    },
  });
})();
