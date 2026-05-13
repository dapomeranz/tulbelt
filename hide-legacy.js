// Hides deprecated tiles in the app editor's right-side context pane. Each
// tile has the class `context-pane-tile`; we identify the ones to hide by the
// text of their first descendant <label>. Hidden via attribute + stylesheet
// so React reconciliation doesn't fight us.

(() => {
const TILE_SELECTOR = '.context-pane-tile';
const FEATURE_ID = 'hide-legacy-tiles';
const STORAGE_KEY = 'toggles';
const STYLE_ID = 'tulbelt-hide-legacy-styles';
const HIDE_ATTR = 'data-tulbelt-hide-legacy';
const LEGACY_LABELS = new Set([
  'Step cycle time',
  'Step comments',
  'Process cycle time',
  'App comments',
  'Step ID',
]);

let enabled = false;
let observer = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `[${HIDE_ATTR}="true"] { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

function tileLabel(tile) {
  return tile.querySelector('label')?.textContent?.trim() ?? '';
}

function applyToAll() {
  for (const tile of document.querySelectorAll(TILE_SELECTOR)) {
    if (tile.getAttribute(HIDE_ATTR) === 'true') continue;
    if (LEGACY_LABELS.has(tileLabel(tile))) {
      tile.setAttribute(HIDE_ATTR, 'true');
    }
  }
}

function restoreAll() {
  for (const tile of document.querySelectorAll(`[${HIDE_ATTR}="true"]`)) {
    tile.removeAttribute(HIDE_ATTR);
  }
}

function onMutation(mutations) {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (
        node.matches?.(TILE_SELECTOR) ||
        node.querySelector?.(TILE_SELECTOR)
      ) {
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
