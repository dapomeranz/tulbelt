// Shared helpers for isolated-world toggle scripts. All scripts in the
// manifest's default content_scripts array run in the same isolated world, so
// this file (listed first there) can hand them helpers via window.__tulbeltLib
// — no ES modules or build step needed. Scripts in the `world: "MAIN"` and
// `all_frames` arrays run elsewhere and can NOT use it.

(() => {
  const STORAGE_KEY = "toggles";

  // The standard toggle lifecycle: reads the feature's flag once at startup,
  // re-reads on every chrome.storage change, and calls onEnable/onDisable only
  // when the value actually flips.
  function registerToggle(featureId, { onEnable, onDisable }) {
    let enabled = false;
    async function syncFromStorage() {
      const { [STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(STORAGE_KEY);
      const next = stored[featureId] === true;
      if (next === enabled) return;
      enabled = next;
      if (enabled) onEnable();
      else onDisable();
    }
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[STORAGE_KEY]) syncFromStorage();
    });
    syncFromStorage();
  }

  // Watches the whole body subtree and calls onMatch once per mutation batch
  // that added an element matching (or containing) `selector`. Returns
  // {start, stop}; both are idempotent.
  function addedNodesObserver(selector, onMatch) {
    let observer = null;
    function onMutation(mutations) {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.(selector) || node.querySelector?.(selector)) {
            onMatch();
            return;
          }
        }
      }
    }
    return {
      start() {
        if (observer) return;
        observer = new MutationObserver(onMutation);
        observer.observe(document.body, { childList: true, subtree: true });
      },
      stop() {
        observer?.disconnect();
        observer = null;
      },
    };
  }

  function ensureStyles(styleId, cssText) {
    if (document.getElementById(styleId)) return;
    const style = document.createElement("style");
    style.id = styleId;
    style.textContent = cssText;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeStyles(styleId) {
    document.getElementById(styleId)?.remove();
  }

  window.__tulbeltLib = { registerToggle, addedNodesObserver, ensureStyles, removeStyles };
})();
