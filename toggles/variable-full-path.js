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
// Strategy:
// - Track the last "Select new variable or array" button clicked (lastTriggerBtn)
// - On click of a nested item, collect all visible rows sorted by top position
// - Walk backward from the clicked row to build the full ancestor path by
//   finding rows with progressively smaller indent levels
// - Patch lastTriggerBtn with the full path after a short delay

(() => {
const FEATURE_ID = 'variable-full-path';
const STORAGE_KEY = 'toggles';
const STASH_ATTR = 'data-tulbelt-vfp-original';
const PATCHED_ATTR = 'data-tulbelt-vfp-patched';
const TRIGGER_BTN_LABEL = 'Select new variable or array';
const SCROLL_CONTAINER_SELECTOR = '[style*="overflow: auto"][style*="will-change: transform"]';

let enabled = false;
let attached = false;
let lastTriggerBtn = null;

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
// Get indent level of an <li>: count leading whitespace/nbsp chars in the
// first <span> inside its <button>. Returns 0 for no indent.
// ---------------------------------------------------------------------------
function indentLevel(li) {
  const firstSpan = li.querySelector('button > span:first-child');
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
  const btn = li.querySelector('button');
  return btn?.getAttribute('aria-label') || btn?.getAttribute('data-testid') || btn?.textContent?.trim() || null;
}

// ---------------------------------------------------------------------------
// Build full path for a clicked <li> by walking backward through sorted rows
// and collecting ancestors with strictly smaller indent levels.
// ---------------------------------------------------------------------------
function buildPath(clickedLi, scrollContainer) {
  const rows = [...(scrollContainer.firstElementChild
    ?.querySelectorAll(':scope > div[style*="position: absolute"]') || [])]
    .sort((a, b) => parseInt(a.style.top) - parseInt(b.style.top));

  // Find the clicked row index
  const clickedRow = clickedLi.parentElement;
  const clickedIdx = rows.findIndex(r => r === clickedRow);
  if (clickedIdx < 0) return null;

  const clickedIndent = indentLevel(clickedLi);
  // Top-level item (indent 0) — no path needed
  if (clickedIndent === 0 && !clickedLi.hasAttribute('disabled')) return null;

  const path = [itemLabel(clickedLi)];
  let currentIndent = clickedIndent;

  // Walk backward to collect ancestors
  for (let i = clickedIdx - 1; i >= 0 && currentIndent > 0; i--) {
    const li = rows[i].querySelector('li');
    if (!li) continue;
    const indent = indentLevel(li);
    // Disabled items with no indent act as group headers
    const isHeader = li.hasAttribute('disabled') && indent === 0;
    if (indent < currentIndent || isHeader) {
      const label = itemLabel(li);
      if (label) path.unshift(label);
      currentIndent = isHeader ? 0 : indent;
    }
  }

  // Only rewrite if we actually found ancestors
  if (path.length <= 1) return null;
  return path.join(' → ');
}

// ---------------------------------------------------------------------------
// Patch / restore the trigger button
// ---------------------------------------------------------------------------
function patchButton(btn, path) {
  if (!btn) return;
  // The visible label is inside a nested div, not a direct span[title].
  // Find the deepest text-bearing element that isn't an SVG.
  const labelEl = btn.querySelector('div > div > div > div') || btn.querySelector('div');
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

// ---------------------------------------------------------------------------
// Click handler
// ---------------------------------------------------------------------------
function handleClick(e) {
  if (!enabled) return;

  // Track which trigger button opened the dropdown
  const triggerBtn = e.target.closest(`button[aria-label="${TRIGGER_BTN_LABEL}"]`);
  if (triggerBtn) {
    lastTriggerBtn = triggerBtn;
    return;
  }

  // Check if a nested field was clicked
  const btn = e.target.closest('button[data-istarget="true"]:not([disabled])');
  if (!btn) return;
  const li = btn.closest('li');
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
