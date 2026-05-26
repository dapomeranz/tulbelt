// In the trigger editor variable picker, nested Object fields are shown with
// only their leaf name after selection. The dropdown uses a virtualised list
// where disabled <li> items are group headers (the Object name) and enabled
// <li> items below them are the selectable nested fields, indented with
// non-breaking spaces in a leading <span>.
//
// This toggle watches for clicks on nested field buttons. When one is clicked
// it walks backward through the virtualised list items to find the nearest
// disabled header above it, then rewrites the selected-value display element
// to show "ObjectName → FieldName". The original text is stashed for revert.
//
// The virtualised list container is:
//   div.sc-dwnOUR  (position:relative, overflow:auto)
// Each row is an absolutely-positioned div containing an <li>:
//   <li class="sc-jfTVlA ...">
//     <button aria-label="FieldName" data-testid="FieldName" data-istarget="true">
//       <span>  (indent — present on nested items, empty on top-level)
//       <span title="FieldName">FieldName</span>
//     </button>
//   </li>
// Disabled <li> items (group headers / Object names) have a disabled="" attr
// on the <li> itself, not on the button.

(() => {
const FEATURE_ID = 'variable-full-path';
const STORAGE_KEY = 'toggles';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';

// The virtualised scroll container that holds all the absolutely-positioned
// row divs. We match by the inline styles Tulip always sets on it.
const SCROLL_CONTAINER_SELECTOR = '[class^="sc-"][style*="overflow: auto"][style*="will-change: transform"]';

// Each row div wraps a single <li>.
const ROW_SELECTOR = 'li[class^="sc-"]';

// The selected-value display: the element whose text we rewrite.
// It sits outside the dropdown list, in the trigger editor's field selector.
// After a click, Tulip updates the button's aria-label / data-testid of the
// currently-selected item — but the "closed" display we want to patch is the
// nearest ancestor container's visible label. We locate it by finding the
// closest container that has a non-list text label element.
//
// Strategy: after a nested field button is clicked, find the nearest ancestor
// that looks like the dropdown trigger/display container, then locate its
// text-bearing child that is NOT inside the virtualised list.
const DISPLAY_SELECTOR = '[class^="sc-"][data-istarget="true"]:not([disabled])';

let enabled = false;
let observer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Is this <li> a group header (disabled, no indent)?
function isGroupHeader(li) {
  return li.hasAttribute('disabled') || li.closest('li[disabled]') === li;
}

// Is this <li> a nested (indented) item?
// Tulip uses a leading <span> with &nbsp;&nbsp; for indent. We detect indent
// by checking if the first span inside the button has non-empty text that is
// only whitespace / nbsp chars.
function isIndented(li) {
  const btn = li.querySelector('button');
  if (!btn) return false;
  const firstSpan = btn.querySelector('span');
  if (!firstSpan) return false;
  const t = firstSpan.textContent;
  // Non-breaking spaces or regular spaces only → this is an indent span
  return t.length > 0 && /^[\s\u00a0]+$/.test(t);
}

// Given a clicked nested-field button, find the Object name above it in the
// virtualised list by walking the absolutely-positioned row divs by their
// `top` style value — find the highest `top` value less than this row's that
// belongs to a disabled (header) li.
function findGroupHeader(clickedBtn) {
  const clickedLi = clickedBtn.closest('li');
  if (!clickedLi) return null;

  const scrollContainer = clickedLi.closest(SCROLL_CONTAINER_SELECTOR);
  if (!scrollContainer) return null;

  // Each li sits inside an absolutely-positioned div with a `top` style.
  const clickedRow = clickedLi.parentElement;
  const clickedTop = parseInt(clickedRow?.style?.top ?? '-1', 10);
  if (clickedTop < 0) return null;

  // Collect all row divs, find the closest disabled header above.
  let bestTop = -1;
  let bestHeader = null;

  const innerContainer = scrollContainer.querySelector('div[style*="height"]');
  const rows = (innerContainer || scrollContainer).querySelectorAll(':scope > div[style*="position: absolute"]');

  for (const row of rows) {
    const top = parseInt(row.style.top ?? '-1', 10);
    if (top < 0 || top >= clickedTop) continue;
    const li = row.querySelector('li');
    if (!li) continue;
    if (isGroupHeader(li) && top > bestTop) {
      bestTop = top;
      bestHeader = li;
    }
  }

  return bestHeader;
}

// Find the label text of a group-header li (the Object name).
function headerLabel(li) {
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || btn?.textContent?.trim() || null;
}

// Find the label text of a nested-field button.
function fieldLabel(btn) {
  return btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent?.trim() || null;
}

// ---------------------------------------------------------------------------
// Find the selected-value display element to patch.
//
// After a click, Tulip keeps the dropdown open (it's a virtualised list
// within a panel, not a floating popover). The "display" we want to patch is
// the button or span outside this panel that shows the currently-chosen value.
//
// The panel's scroll container is inside a chain of sc-* divs. We walk up
// from the scroll container to find the first ancestor that also contains a
// sibling-or-cousin element with a visible text label we can rewrite.
//
// Observation from the pasted HTML: the scroll container sits inside
// div.sc-dwnOUR inside div[style*="overflow: visible; height: 0px"] inside
// div.sc-jIILKH. We look for a button[data-istarget="true"] that is a sibling
// of (or near) the overflow:visible wrapper — that button is the closed-state
// display for the currently selected value.
// ---------------------------------------------------------------------------
function findDisplayButton(scrollContainer) {
  // Walk up until we find a container that has a data-istarget button sibling
  // that is NOT inside the virtualised list itself.
  let node = scrollContainer.parentElement;
  for (let i = 0; i < 8 && node; i++) {
    // Look for a data-istarget button that is NOT a descendant of the scroll container
    const candidates = node.querySelectorAll('button[data-istarget="true"]:not([disabled])');
    for (const c of candidates) {
      if (!scrollContainer.contains(c) && !c.closest(SCROLL_CONTAINER_SELECTOR)) {
        return c;
      }
    }
    node = node.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Patch / restore the display button
// ---------------------------------------------------------------------------
function patchDisplay(displayBtn, path) {
  // The visible label is inside a <span title="..."> inside the button.
  const labelSpan = displayBtn.querySelector('span[title]');
  const target = labelSpan || displayBtn;

  if (target.getAttribute(PATCHED_ATTR) === path) return;
  if (!target.hasAttribute(STASH_ATTR)) {
    target.setAttribute(STASH_ATTR, target.textContent);
  }
  target.setAttribute(PATCHED_ATTR, path);
  // Update both textContent and the title attribute so tooltips match.
  target.textContent = path;
  if (target.hasAttribute('title')) target.setAttribute('title', path);
  if (displayBtn.hasAttribute('aria-label')) displayBtn.setAttribute('aria-label', path);
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${STASH_ATTR}]`)) {
    el.textContent = el.getAttribute(STASH_ATTR);
    if (el.hasAttribute('title')) el.setAttribute('title', el.getAttribute(STASH_ATTR));
    el.removeAttribute(STASH_ATTR);
    el.removeAttribute(PATCHED_ATTR);
    // Also restore aria-label on the button if we changed it.
    const btn = el.closest('button[data-istarget="true"]') || (el.matches('button') ? el : null);
    if (btn) {
      const orig = btn.getAttribute(STASH_ATTR);
      if (orig) btn.setAttribute('aria-label', orig);
    }
  }
}

// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------
function handleClick(e) {
  if (!enabled) return;
  const btn = e.target.closest('button[data-istarget="true"]:not([disabled])');
  if (!btn) return;

  const li = btn.closest('li');
  if (!li || !isIndented(li)) return; // top-level item — no path needed

  const header = findGroupHeader(btn);
  if (!header) return;

  const objName = headerLabel(header);
  const fieldName = fieldLabel(btn);
  if (!objName || !fieldName) return;

  const path = `${objName} → ${fieldName}`;

  // Give Tulip a tick to update the DOM after the click, then patch.
  const scrollContainer = li.closest(SCROLL_CONTAINER_SELECTOR);
  if (!scrollContainer) return;

  setTimeout(() => {
    const display = findDisplayButton(scrollContainer);
    if (display) patchDisplay(display, path);
  }, 50);
}

// ---------------------------------------------------------------------------
// Observer: watch for the virtualised list containers appearing (SPA nav)
// ---------------------------------------------------------------------------
function startObserver() {
  if (observer) return;
  // Use capture-phase click so we get it before React's handlers.
  document.addEventListener('click', handleClick, true);
  observer = true; // sentinel
}

function stopObserver() {
  if (!observer) return;
  document.removeEventListener('click', handleClick, true);
  observer = null;
}

// ---------------------------------------------------------------------------
// Storage sync
// ---------------------------------------------------------------------------
async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] ?? true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    startObserver();
  } else {
    stopObserver();
    restoreAll();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
