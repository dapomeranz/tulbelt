// Strips the leading "Tulip | " from the tab title. Tulip sets
// `document.title` on every SPA navigation, so we watch the <title> element
// for text changes and rewrite each new value. The most recently observed
// un-stripped title is cached so disabling the toggle can put it back.

(() => {
  const { registerToggle } = window.__tulbeltLib;

  const FEATURE_ID = "strip-tab-title-prefix";
  const PREFIX = "Tulip | ";

  let titleObserver = null;
  let headObserver = null;
  let lastOriginalTitle = null;

  function stripIfNeeded() {
    const title = document.title;
    if (title.startsWith(PREFIX)) {
      lastOriginalTitle = title;
      document.title = title.slice(PREFIX.length);
    }
  }

  function observeTitleEl(titleEl) {
    titleObserver = new MutationObserver(stripIfNeeded);
    titleObserver.observe(titleEl, {
      childList: true,
      characterData: true,
      subtree: true,
    });
    stripIfNeeded();
  }

  function startObserver() {
    if (titleObserver || headObserver) return;
    const titleEl = document.querySelector("title");
    if (titleEl) {
      observeTitleEl(titleEl);
      return;
    }
    // <title> not in the document yet; wait for it.
    headObserver = new MutationObserver(() => {
      const t = document.querySelector("title");
      if (!t) return;
      headObserver.disconnect();
      headObserver = null;
      observeTitleEl(t);
    });
    headObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function stopObserver() {
    titleObserver?.disconnect();
    titleObserver = null;
    headObserver?.disconnect();
    headObserver = null;
  }

  function restore() {
    if (lastOriginalTitle !== null && !document.title.startsWith(PREFIX)) {
      document.title = lastOriginalTitle;
    }
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      startObserver();
    },
    onDisable() {
      stopObserver();
      restore();
    },
  });
})();
