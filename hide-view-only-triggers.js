// Hides locked/read-only trigger rows in the app editor's trigger list.
// View-only rows carry the `view-only` class on the same element that holds
// the generated `…--triggerRowStyles` class; regular trigger rows have only
// the generated class. A single CSS rule covers it — no DOM scan needed.

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
    `[class*="triggerRowStyles"].view-only { display: none !important; }`;
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
