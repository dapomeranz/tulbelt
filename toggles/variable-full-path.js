// In the trigger editor variable picker, nested Object fields are grouped
// under a disabled <li> header. After selecting a nested field, only the
// leaf name is shown in the trigger button display. This toggle rewrites
// the display to show "ObjectName → FieldName".
//
// The dropdown is rendered in a portal — it is not a DOM descendant of the
// trigger button that opened it. So we track which trigger button was most
// recently clicked ("lastTriggerBtn"), then patch that specific button after
// a nested field is selected.

(() => {
const FEATURE_ID = 'variable-full-path';
const STORAGE_KEY = 'toggles';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';

// The button that opens the dropdown. Multiple exist on the page; we track
// whichever was clicked most recently.
const TRIGGER_BTN_LABEL = 'Select new variable or array';
const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';

let enabled = false;
let attached = false;
let lastTriggerBtn = null; // the button that opened the current dropdown

// ---------------------------------------------------------------------------
// Find the variable-picker scroll container (has <li> children)
// ---------------------------------------------------------------------------
function findVariableContainer() {
  for (const sc of document.querySelectorAll(SCROLL_CONTAINER_SELECTOR)) {
    if (sc.querySelector('li')) return sc;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Is this <li> a nested (indented) item?
// Tulip uses a leading <span> with &nbsp; chars for indent.
// ---------------------------------------------------------------------------
function isIndented(li) {
  const firstSpan = li.querySelector('button > span:first-child');
  if (!firstSpan) return false;
  return firstSpan.textContent.length > 0 && /^[\s\u00a0]+$/.test(firstSpan.textContent);
}

// ---------------------------------------------------------------------------
// Find the nearest disabled group-header <li> ABOVE the clicked row.
// Headers have a lower `top` value than their children.
// ---------------------------------------------------------------------------
function findGroupHeader(clickedLi, scrollContainer) {
  const clickedRow = clickedLi.parentElement;
  const clickedTop = parseInt(clickedRow?.style?.top ?? '-1', 10);
  if (clickedTop < 0) return null;

  const rows = scrollContainer.firstElementChild
    ?.querySelectorAll(':scope > div[style*="position: absolute"]') || [];

  let bestTop = -1;
  let bestHeader = null;

  for (const row of rows) {
    const top = parseInt(row.style.top ?? '-1', 10);
    if (top < 0 || top >= clickedTop) continue;
    const li = row.querySelector('li');
    if (li?.hasAttribute('disabled') && top > bestTop) {
      bestTop = top;
      bestHeader = li;
    }
  }

  return bestHeader;
}

function headerLabel(li) {
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || null;
}

function fieldLabel(btn) {
  return btn.getAttribute('aria-label') || btn.getAttribute('data-testid') || null;
}

// ---------------------------------------------------------------------------
// Patch the trigger button that opened the dropdown
// ---------------------------------------------------------------------------
function patchButton(btn, path) {
  if (!btn) return;
  const labelSpan = btn.querySelector('span[title]');
  const target = labelSpan || btn;
  if (target.getAttribute(PATCHED_ATTR) === path) return;
  if (!target.hasAttribute(STASH_ATTR)) {
    target.setAttribute(STASH_ATTR, target.textContent);
  }
  target.setAttribute(PATCHED_ATTR, path);
  target.textContent = path;
  if (target.hasAttribute('title')) target.setAttribute('title', path);
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${STASH_ATTR}]`)) {
    el.textContent = el.getAttribute(STASH_ATTR);
    if (el.hasAttribute('title')) el.setAttribute('title', el.getAttribute(STASH_ATTR));
    el.removeAttribute(STASH_ATTR);
    el.removeAttribute(PATCHED_ATTR);
  }
}

// ---------------------------------------------------------------------------
// Click handler — capture phase so we see all clicks
// ---------------------------------------------------------------------------
function handleClick(e) {
  if (!enabled) return;

  // Track which trigger button was clicked to open the dropdown
  const triggerBtn = e.target.closest(`button[aria-label="${TRIGGER_BTN_LABEL}"]`);
  if (triggerBtn) {
    lastTriggerBtn = triggerBtn;
    return;
  }

  // Check if a nested field was clicked inside the variable picker
  const btn = e.target.closest('button[data-istarget="true"]:not([disabled])');
  if (!btn) return;

  const li = btn.closest('li');
  if (!li || !isIndented(li)) return;

  const scrollContainer = findVariableContainer();
  if (!scrollContainer || !scrollContainer.contains(li)) return;

  const header = findGroupHeader(li, scrollContainer);
  if (!header) return;

  const objName = headerLabel(header);
  const fname = fieldLabel(btn);
  if (!objName || !fname) return;

  const path = `${objName} → ${fname}`;
  const targetBtn = lastTriggerBtn;

  setTimeout(() => {
    if (targetBtn) patchButton(targetBtn, path);
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
  lastTriggerBtn = null;
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
