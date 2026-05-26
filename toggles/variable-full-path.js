// In the trigger editor variable picker, nested Object fields are grouped
// under a disabled <li> that acts as a group FOOTER (it appears below its
// children in the virtualised list, not above). Selectable nested fields are
// indented with a leading &nbsp;&nbsp; span.
//
// This toggle intercepts clicks on nested field buttons, finds the nearest
// disabled group-footer <li> below the clicked row (by comparing absolute
// `top` values), and rewrites the selected-value display to show
// "ObjectName → FieldName".

(() => {
const FEATURE_ID = 'variable-full-path';
const STORAGE_KEY = 'toggles';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';

const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';

let enabled = false;
let attached = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A nested (indented) item has a first <span> whose text is only whitespace/nbsp
function isIndented(li) {
  const firstSpan = li.querySelector('button > span:first-child');
  if (!firstSpan) return false;
  const t = firstSpan.textContent;
  return t.length > 0 && /^[\s\u00a0]+$/.test(t);
}

// Given a clicked nested-field button, find the nearest disabled group-footer
// <li> that appears BELOW it in the virtualised list (lowest top > clickedTop).
function findGroupFooter(clickedLi) {
  const scrollContainer = clickedLi.closest(SCROLL_CONTAINER_SELECTOR);
  if (!scrollContainer) return null;

  const clickedRow = clickedLi.parentElement;
  const clickedTop = parseInt(clickedRow?.style?.top ?? '-1', 10);
  if (clickedTop < 0) return null;

  // Find the inner div that holds all the absolutely-positioned rows
  const inner = scrollContainer.querySelector(':scope > div > div');
  const rowsParent = inner || scrollContainer;
  const rows = rowsParent.querySelectorAll(':scope > div[style*="position: absolute"]');

  let bestTop = Infinity;
  let bestFooter = null;

  for (const row of rows) {
    const top = parseInt(row.style.top ?? '-1', 10);
    if (top <= clickedTop) continue; // only look below the clicked item
    const li = row.querySelector('li');
    if (!li) continue;
    if (li.hasAttribute('disabled') && top < bestTop) {
      bestTop = top;
      bestFooter = li;
    }
  }

  return bestFooter;
}

function groupLabel(li) {
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || btn?.textContent?.trim() || null;
}

function fieldLabel(btn) {
  return btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || btn.textContent?.trim() || null;
}

// ---------------------------------------------------------------------------
// Find the selected-value display element to patch.
// The display button is the one that triggered the dropdown to open — it sits
// outside the scroll container and shows the currently-selected value.
// We walk up from the scroll container looking for a button[data-istarget]
// that is NOT inside the scroll container.
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
    if (!displayBtn.hasAttribute(STASH_ATTR)) {
      displayBtn.setAttribute(STASH_ATTR + '-aria', displayBtn.getAttribute('aria-label'));
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
  for (const el of document.querySelectorAll(`[${STASH_ATTR}-aria]`)) {
    el.setAttribute('aria-label', el.getAttribute(STASH_ATTR + '-aria'));
    el.removeAttribute(STASH_ATTR + '-aria');
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

  const footer = findGroupFooter(li);
  if (!footer) return;

  const objName = groupLabel(footer);
  const fname = fieldLabel(btn);
  if (!objName || !fname) return;

  const path = `${objName} → ${fname}`;

  const scrollContainer = li.closest(SCROLL_CONTAINER_SELECTOR);
  if (!scrollContainer) return;

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
