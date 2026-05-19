// Hides base-layout trigger rows in the app editor's trigger list.
// Inherited layout triggers are view-only (lock icon, no row actions). App
// triggers can also be view-only but expose copy/view buttons — keep those.

(() => {
const FEATURE_ID = 'hide-view-only-triggers';
const STORAGE_KEY = 'toggles';
const STYLE_ID = 'tulbelt-hide-view-only-triggers-styles';

let enabled = false;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent =
    `[class*="triggerRowStyles"].view-only:not(:has([data-testid^="view-trigger-"])) { display: none !important; }`;
  (document.head || document.documentElement).appendChild(style);
}

function removeStyles() {
  document.getElementById(STYLE_ID)?.remove();
}

async function syncFromStorage() {
  const { [STORAGE_KEY]: stored = {} } =
    await chrome.storage.local.get(STORAGE_KEY);
  const next = stored[FEATURE_ID] ?? false;
  if (next === enabled) return;
  enabled = next;
  if (enabled) ensureStyles();
  else removeStyles();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncFromStorage();
});

syncFromStorage();
})();
