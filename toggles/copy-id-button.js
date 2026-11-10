// Adds a "Copy ID" button beside the title on table and app pages. The id comes
// from the URL, which on both pages is the same id the API uses, and it's read
// at click time so the button can't go stale across SPA navigation. The button
// is a sibling appended after React's own title element, so reconciliation
// leaves it alone; the subheader can still be remounted under it, hence the
// observer putting it back.

(() => {
  const { registerToggle, ensureStyles, removeStyles } = window.__tulbeltLib;

  const FEATURE_ID = "copy-id-button";
  const STYLE_ID = "tulbelt-copy-id-styles";
  const BUTTON_ID = "tulbelt-copy-id";
  const TITLE_SELECTOR = '[data-testid="subheader-title"]';
  const LABEL = "Copy ID";
  const FEEDBACK_MS = 1200;

  // The /w/<workspace> prefix is optional. /apps/folders/... is a list of apps,
  // not an app.
  const ROUTES = [
    { kind: "table", pattern: /^(?:\/w\/[^/]+)?\/table\/([^/]+)/ },
    { kind: "app", pattern: /^(?:\/w\/[^/]+)?\/apps\/(?!folders(?:\/|$))([^/]+)/ },
  ];

  const CSS = `
    #${BUTTON_ID} {
      flex: 0 0 auto;
      margin-left: 12px;
      padding: 2px 8px;
      border: 1px solid #dfe1e5;
      border-radius: 4px;
      background: transparent;
      color: inherit;
      font: inherit;
      font-size: 12px;
      font-weight: 400;
      line-height: 18px;
      white-space: nowrap;
      cursor: pointer;
    }
    #${BUTTON_ID}:hover {
      background: rgba(58, 69, 82, 0.08);
    }
  `;

  let observer = null;
  let frame = 0;
  let feedbackTimer = 0;

  function currentTarget() {
    for (const { kind, pattern } of ROUTES) {
      const match = pattern.exec(location.pathname);
      if (match) return { kind, id: match[1] };
    }
    return null;
  }

  function showFeedback(button, text) {
    clearTimeout(feedbackTimer);
    button.textContent = text;
    feedbackTimer = setTimeout(() => {
      button.textContent = LABEL;
    }, FEEDBACK_MS);
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    const button = event.currentTarget;
    const target = currentTarget();
    if (!target) return;
    navigator.clipboard.writeText(target.id).then(
      () => showFeedback(button, "Copied"),
      () => showFeedback(button, "Copy failed"),
    );
  }

  function createButton() {
    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.type = "button";
    button.textContent = LABEL;
    button.addEventListener("click", onClick);
    return button;
  }

  function sync() {
    const target = currentTarget();
    const title = target && document.querySelector(TITLE_SELECTOR);
    const existing = document.getElementById(BUTTON_ID);
    if (!title) {
      existing?.remove();
      return;
    }
    const button = existing ?? createButton();
    if (button.previousElementSibling !== title) title.after(button);
    button.title = `Copy ${target.kind} ID: ${target.id}`;
  }

  function scheduleSync() {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    }
  }

  registerToggle(FEATURE_ID, {
    onEnable() {
      ensureStyles(STYLE_ID, CSS);
      sync();
      observer = new MutationObserver(scheduleSync);
      observer.observe(document.body, { childList: true, subtree: true });
    },
    onDisable() {
      observer?.disconnect();
      observer = null;
      cancelAnimationFrame(frame);
      frame = 0;
      clearTimeout(feedbackTimer);
      document.getElementById(BUTTON_ID)?.remove();
      removeStyles(STYLE_ID);
    },
  });
})();
