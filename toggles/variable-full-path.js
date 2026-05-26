// In the trigger editor variable picker, nested Object fields are grouped
// under a disabled <li> header that appears ABOVE its children in the
// virtualised list. Selectable nested fields are indented with a leading
// &nbsp;&nbsp; span.
//
// This toggle intercepts clicks on nested field buttons, finds the nearest
// disabled group-header <li> ABOVE the clicked row (by comparing absolute
// `top` values in the virtualised list), and rewrites the selected-value
// display to show "ObjectName → FieldName".
//
// The page has two scroll containers matching the overflow/will-change style;
// we target the one that contains <li> elements (the variable picker), not
// the one that contains tree-item divs (the step list).

(() => {
const FEATURE_ID = 'variable-full-path';
const STORAGE_KEY = 'toggles';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const STASH_ARIA_ATTR = 'data-tulbelt-vfp-original-aria';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';

const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';

let enabled = false;
let attached = false;

// ---------------------------------------------------------------------------
// Find the variable-picker scroll container (has <li> children, not tree-items)
// ---------------------------------------------------------------------------
function findVariableContainer() {
  const all = document.querySelectorAll(SCROLL_CONTAINER_SELECTOR);
  for (const sc of all) {
    if (sc.querySelector('li')) return sc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A nested (indented) item has a first <span> inside the button whose text
// is only whitespace / non-breaking spaces.
function isIndented(li) {
  const firstSpan = li.querySelector('button > span:first-child');
  if (!firstSpan) return false;
  const t = firstSpan.textContent;
  return t.length > 0 && /^[\s\u00a0]+$/.test(t);
}

// Given a clicked nested-field <li>, find the nearest disabled group-header
// <li> that appears ABOVE it in the virtualised list (highest top < clickedTop).
function findGroupHeader(clickedLi, scrollContainer) {
  const clickedRow = clickedLi.parentElement;
  const clickedTop = parseInt(clickedRow?.style?.top ?? '-1', 10);
  if (clickedTop < 0) return null;

  const outer = scrollContainer.querySelector(':scope > div');
  const rowsParent = outer || scrollContainer;
  const rows = rowsParent.querySelectorAll(':scope > div[style*="position: absolute"]');

  let bestTop = -1;
  let bestHeader = null;

  for (const row of rows) {
    const top = parseInt(row.style.top ?? '-1', 10);
    if (top < 0 || top >= clickedTop) continue; // only look above clicked item
    const li = row.querySelector('li');
    if (!li) continue;
    if (li.hasAttribute('disabled') && top > bestTop) {
      bestTop = top;
      bestHeader = li;
    }
  }

  return bestHeader;
}

function headerLabel(li) {
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || btn?.textContent?.trim() || null;
}

function fieldLabel(btn) {
  return btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent?.trim() || null;
}

// ---------------------------------------------------------------------------
// Find the selected-value display button to patch.
// It's the button that opened the dropdown — sits outside the scroll container
// with data-istarget="true" and is not disabled.
// ---------------------------------------------------------------------------
function findDisplayButton(scrollContainer) {
  let node = scrollContainer.parentElement;
  for (let i = 0; i < 10 && node; i++) {
    const candidates = node.querySelectorAll('button[data-istarget="true"]:not([disabled])');
    for (const c of candidates) {
      if (!scrollContainer.contains(c)) return c;
    }
    node = node.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Patch / restore
// ---------------------------------------------------------------------------
function patchDisplay(displayBtn, path) {
  const labelSpan = displayBtn.querySelector('span[title]');
  const target = labelSpan || displayBtn;
  if (target.getAttribute(PATCHED_ATTR) === path) return;
  if (!target.hasAttribute(STASH_ATTR)) {
    target.setAttribute(STASH_ATTR, target.textContent);
  }
  target.setAttribute(PATCHED_ATTR, path);
  target.textContent = path;
  if (target.hasAttribute('title')) target.setAttribute('title', path);
  if (displayBtn !== target && displayBtn.hasAttribute('aria-label')) {
    if (!displayBtn.hasAttribute(STASH_ARIA_ATTR)) {
      displayBtn.setAttribute(STASH_ARIA_ATTR, displayBtn.getAttribute('aria-label'));
    }
    displayBtn.setAttribute('aria-label', path);
  }
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${STASH_ATTR}]`)) {
    el.textContent = el.getAttribute(STASH_ATTR);
    if (el.hasAttribute('title')) el.setAttribute('title', el.getAttribute(STASH_ATTR));
    el.removeAttribute(STASH_ATTR);
    el.removeAttribute(PATCHED_ATTR);
  }
  for (const el of document.querySelectorAll(`[${STASH_ARIA_ATTR}]`)) {
    el.setAttribute('aria-label', el.getAttribute(STASH_ARIA_ATTR));
    el.removeAttribute(STASH_ARIA_ATTR);
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
  if (!li || !isIndented(li)) return; // not a nested field

  const scrollContainer = findVariableContainer();
  if (!scrollContainer || !scrollContainer.contains(li)) return;

  const header = findGroupHeader(li, scrollContainer);
  if (!header) return;

  const objName = headerLabel(header);
  const fname = fieldLabel(btn);
  if (!objName || !fname) return;

  const path = `${objName} → ${fname}`;

  // Wait a tick for Tulip to update the display after the click
  setTimeout(() => {
    const display = findDisplayButton(scrollContainer);
    if (display) patchDisplay(display, path);
  }, 80);
}

// ---------------------------------------------------------------------------
// Enable / disable
// ---------------------------------------------------------------------------
function startObserver() {
  if (attached) return;
  document.addEventListener('click', handleClick, true);
  attached = true;
}

function stopObserver() {
  if (!attached) return;
  document.removeEventListener('click', handleClick, true);
  attached = false;
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
  if (enabled) startObserver();
  else { stopObserver(); restoreAll(); }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
