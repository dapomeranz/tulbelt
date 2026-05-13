// Visually moves the last two cells (edit + action menu) next to the name
// cell on tulip.co app/folder list rows. Uses CSS `order` rather than moving
// DOM nodes so React reconciliation doesn't fight us. Column widths are
// permuted via inline grid-template-columns so the action buttons keep their
// 44px slots.

(() => {
const ROW_SELECTOR = '[role="row"][widths]';
const ACTION_MENU_SELECTOR = '[data-testid="app-actions-menu"]';
const FEATURE_ID = 'reorder-row-buttons';
const STORAGE_KEY = 'toggles';
const STYLE_ID = 'tulbelt-reorder-styles';
const REORDER_ATTR = 'data-tulbelt-reorder';

let enabled = false;
let observer = null;
const knownBodyWidths = new Set();

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Middle cells default to a high order; first cell stays first and the last
  // two are pulled forward into slots 2 and 3.
  style.textContent = `
    [${REORDER_ATTR}="true"] > * { order: 5; }
    [${REORDER_ATTR}="true"] > :first-child { order: 1; }
    [${REORDER_ATTR}="true"] > :nth-last-child(2) { order: 2; }
    [${REORDER_ATTR}="true"] > :last-child { order: 3; }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

// Splits a grid-template-columns–style string on top-level whitespace, so
// `minmax(300px, 1fr) 44px` becomes ["minmax(300px, 1fr)", "44px"].
function splitTrackList(str) {
  const tokens = [];
  let depth = 0;
  let current = '';
  for (const c of str) {
    if (c === '(') depth++;
    else if (c === ')') depth--;
    if (/\s/.test(c) && depth === 0) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += c;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function isBodyRow(row) {
  return !!row.querySelector(ACTION_MENU_SELECTOR);
}

function reorderRow(row) {
  if (row.getAttribute(REORDER_ATTR) === 'true') return;
  const widthsAttr = row.getAttribute('widths') || '';
  const widths = splitTrackList(widthsAttr);
  if (widths.length < 4) return;

  if (isBodyRow(row)) {
    knownBodyWidths.add(widthsAttr);
  } else if (!knownBodyWidths.has(widthsAttr)) {
    // Not a body row and not matching one we've seen — skip (likely an
    // unrelated table or the header rendered before any body row).
    return;
  }

  const reordered = [
    widths[0],
    widths[widths.length - 2],
    widths[widths.length - 1],
    ...widths.slice(1, -2),
  ];
  row.style.setProperty(
    'grid-template-columns',
    reordered.join(' '),
    'important'
  );
  row.setAttribute(REORDER_ATTR, 'true');
}

function restoreRow(row) {
  row.style.removeProperty('grid-template-columns');
  row.removeAttribute(REORDER_ATTR);
}

function applyToAll() {
  const rows = document.querySelectorAll(ROW_SELECTOR);
  // First pass collects widths signatures from body rows, second pass picks
  // up matching header rows whose action menu is absent.
  for (const row of rows) if (isBodyRow(row)) reorderRow(row);
  for (const row of rows) reorderRow(row);
}

function restoreAll() {
  for (const row of document.querySelectorAll(`[${REORDER_ATTR}="true"]`)) {
    restoreRow(row);
  }
  knownBodyWidths.clear();
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches?.(ROW_SELECTOR) || node.querySelector?.(ROW_SELECTOR)) {
        applyToAll();
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

async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] ?? true;
  if (next === enabled) return;
  enabled = next;
  if (enabled) {
    ensureStyles();
    applyToAll();
    startObserver();
  } else {
    stopObserver();
    restoreAll();
    removeStyles();
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
