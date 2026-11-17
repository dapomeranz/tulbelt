// In the tulip.co app editor, count time the user is actively editing each
// app and, every ACTIVE_THRESHOLD_MS of active time, drive the native snapshot flow:
// click the snapshot button, fill the description, click Create snapshot.
//
// "Active" means: tab visible, URL still on [/w/<ws>]/apps/<id>/versions/..., and an
// input event seen in the last IDLE_AFTER_MS. Time is bucketed per app id so
// switching apps doesn't bleed counters together. The count lives in storage
// and each tab adds its own active time to it, so tabs open on one app share
// one count and take one snapshot between them.
//
// Every start() and stop() bumps `run`; anything started under an older run
// (a start still loading state, a snapshot still waiting on its modal) sees
// that and stops, so a snapshot never completes after the toggle goes off.

(() => {
  const FEATURE_ID = "auto-snapshot";
  const TOGGLES_KEY = "toggles";
  const STATE_KEY = "autoSnapshotState";
  const URL_PATTERN = /^https?:\/\/([^.]+)\.(?:tulip\.co|dmgmori-tulip\.com)(?:\/w\/[^/]+)?\/apps\/([^/]+)\/versions(\/|$)/;
  const ACTIVE_THRESHOLD_MS = 15 * 60 * 1000;
  const IDLE_AFTER_MS = 60 * 1000;
  const TICK_MS = 1000;
  const PERSIST_EVERY_MS = 10 * 1000;
  const RETRY_AFTER_MS = 60 * 1000;
  const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel", "touchstart", "scroll"];

  let enabled = false;
  let run = 0;
  let currentAppId = null;
  let lastActivityAt = 0;
  let lastPersistAt = 0;
  let activeMs = {}; // appId -> stored active milliseconds, as last read
  let pendingMs = 0; // this tab's active time on currentAppId not yet stored
  let retryAt = 0; // after a failed snapshot, don't try again before this
  let tickHandle = null;
  let urlPollHandle = null;
  let busy = false;
  let saving = Promise.resolve();

  /** MV3 content scripts usually expose `chrome.storage`; Firefox / some builds use `browser`. */
  function storageLocal() {
    return globalThis.chrome?.storage?.local ?? globalThis.browser?.storage?.local ?? null;
  }

  // When the extension is reloaded/updated, content scripts in already-open
  // tabs become orphaned: `chrome.runtime.id` goes undefined and any chrome.*
  // call rejects with "Extension context invalidated." Detect this so we can
  // shut down cleanly instead of spamming unhandled rejections from `tick`.
  function isContextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id ?? globalThis.browser?.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(err) {
    return /Extension context invalidated|Extension manifest must request permission/i.test(
      err?.message ?? "",
    );
  }

  function getAppId(url = location.href) {
    const m = URL_PATTERN.exec(url);
    return m ? m[2] : null;
  }

  async function loadState() {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    try {
      const { [STATE_KEY]: stored = {} } = await local.get(STATE_KEY);
      activeMs = stored;
    } catch (err) {
      if (isContextInvalidatedError(err)) stop();
      else throw err;
    }
  }

  // Read-modify-write of the stored counts, one at a time within the tab.
  // Re-reading first keeps other tabs' counts, and leaves activeMs with what
  // they've added since.
  function save(change) {
    saving = saving
      .then(async () => {
        const local = storageLocal();
        if (!local || !isContextValid()) return;
        const { [STATE_KEY]: stored = {} } = await local.get(STATE_KEY);
        change(stored);
        await local.set({ [STATE_KEY]: stored });
        activeMs = stored;
      })
      .catch((err) => {
        if (isContextInvalidatedError(err)) stop();
      });
    return saving;
  }

  // Adds this tab's unsaved time to the app's stored count.
  function flush(appId) {
    const add = pendingMs;
    pendingMs = 0;
    if (!appId) return saving;
    return save((stored) => {
      stored[appId] = (stored[appId] || 0) + add;
    });
  }

  function resetCount(appId) {
    return save((stored) => {
      stored[appId] = 0;
    });
  }

  function markActivity() {
    lastActivityAt = Date.now();
  }

  function isActive() {
    return document.visibilityState === "visible" && Date.now() - lastActivityAt < IDLE_AFTER_MS;
  }

  function showOverlay(message) {
    let el = document.getElementById("tulbelt-snapshot-overlay");
    if (!el) {
      el = document.createElement("div");
      el.id = "tulbelt-snapshot-overlay";
      el.style.cssText = [
        "position:fixed",
        "top:16px",
        "right:16px",
        "z-index:2147483647",
        "background:rgba(28,105,225,0.95)",
        "color:#fff",
        "padding:10px 14px",
        "border-radius:8px",
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
        "box-shadow:0 4px 16px rgba(0,0,0,0.2)",
        "max-width:280px",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(el);
    }
    el.textContent = message;
    return el;
  }

  function hideOverlay() {
    document.getElementById("tulbelt-snapshot-overlay")?.remove();
  }

  function waitForElement(selector, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const existing = document.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }
      const obs = new MutationObserver(() => {
        const node = document.querySelector(selector);
        if (node) {
          obs.disconnect();
          clearTimeout(timer);
          resolve(node);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        obs.disconnect();
        reject(new Error(`timed out waiting for ${selector}`));
      }, timeoutMs);
    });
  }

  // React controls these inputs, so a plain `.value = x` won't fire onChange.
  // Going through the prototype setter makes React see the change.
  function setReactValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // The snapshot button, when a snapshot can start now: not while another
  // modal is up (don't fight the user), and not while the button is disabled.
  function snapshotButton() {
    if (document.querySelector('[data-testid="modal"]')) return null;
    const btn = document.querySelector('[data-testid="app-editor-snapshot"]');
    if (!btn || btn.disabled || btn.getAttribute("aria-disabled") === "true") return null;
    return btn;
  }

  const CANCELLED = new Error("cancelled");

  // true: snapshot taken. false: it failed. null: not taken, and nothing
  // shown (no button to click, or the toggle went off mid-flow).
  async function performSnapshot(appId, myRun) {
    const snapshotBtn = snapshotButton();
    if (!snapshotBtn) return null;

    const overlay = showOverlay("Tulbelt: capturing snapshot…");
    try {
      snapshotBtn.click();

      const textarea = await waitForElement('[data-testid="version-description-input"]');
      if (myRun !== run) throw CANCELLED;
      const minutes = Math.round((activeMs[appId] || 0) / 60000);
      const stamp = new Date().toISOString().replace("T", " ").slice(0, 16);
      setReactValue(
        textarea,
        `Tulbelt auto-snapshot after ${minutes} min of active editing — ${stamp} UTC`,
      );

      const confirmBtn = await waitForElement('[data-testid="publish-confirm"]');
      // Brief pause so React processes the input event and enables submit.
      await new Promise((r) => setTimeout(r, 150));
      if (myRun !== run) throw CANCELLED;
      confirmBtn.click();

      overlay.textContent = "Tulbelt: snapshot created.";
      setTimeout(hideOverlay, 2000);
      return true;
    } catch (err) {
      // Close the half-open modal: the next attempt starts clean, and a
      // toggle switched off mid-flow leaves no modal of its own behind.
      document.querySelector('[data-testid="close-modal-button"]')?.click();
      if (myRun !== run) {
        hideOverlay();
        return null;
      }
      overlay.textContent = `Tulbelt: snapshot failed (${err.message}).`;
      setTimeout(hideOverlay, 4000);
      return false;
    }
  }

  async function tick() {
    if (!isContextValid()) {
      stop();
      return;
    }
    if (busy) return;
    if (!currentAppId) return;
    if (!isActive()) return;

    pendingMs += TICK_MS;
    const appId = currentAppId;
    const now = Date.now();
    const due =
      (activeMs[appId] || 0) + pendingMs >= ACTIVE_THRESHOLD_MS &&
      now >= retryAt &&
      snapshotButton() !== null;
    if (!due && now - lastPersistAt < PERSIST_EVERY_MS) return;

    const myRun = run;
    busy = true;
    try {
      lastPersistAt = now;
      // Saving before a snapshot also reads the count back: if another tab on
      // this app just took one, the count is back near zero and this tab skips.
      await flush(appId);
      if (!due || myRun !== run || appId !== currentAppId) return;
      if ((activeMs[appId] || 0) < ACTIVE_THRESHOLD_MS) return;
      const ok = await performSnapshot(appId, myRun);
      if (ok) await resetCount(appId);
      // After a failure, wait before trying again; the counter stays, so the
      // retry still happens once whatever blocked it clears.
      else if (ok === false) retryAt = Date.now() + RETRY_AFTER_MS;
    } finally {
      busy = false;
    }
  }

  function checkUrl() {
    const newAppId = getAppId();
    if (newAppId !== currentAppId) {
      // Save the outgoing app's time before switching so it isn't lost.
      if (currentAppId) void flush(currentAppId);
      currentAppId = newAppId;
      pendingMs = 0;
      if (currentAppId) markActivity();
    }
  }

  function startActivityListeners() {
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, markActivity, {
        passive: true,
        capture: true,
      });
    }
  }

  function stopActivityListeners() {
    for (const ev of ACTIVITY_EVENTS) {
      window.removeEventListener(ev, markActivity, { capture: true });
    }
  }

  async function start() {
    const myRun = ++run;
    await loadState();
    // Switched off (or off and on again) while the state loaded: that later
    // call owns the timers now.
    if (myRun !== run) return;
    pendingMs = 0;
    retryAt = 0;
    checkUrl();
    markActivity();
    startActivityListeners();
    tickHandle = setInterval(tick, TICK_MS);
    urlPollHandle = setInterval(checkUrl, 1000);
  }

  function stop() {
    run++;
    if (tickHandle) clearInterval(tickHandle);
    if (urlPollHandle) clearInterval(urlPollHandle);
    tickHandle = null;
    urlPollHandle = null;
    stopActivityListeners();
    hideOverlay();
    if (currentAppId) void flush(currentAppId);
    currentAppId = null;
  }

  async function syncFromStorage() {
    const local = storageLocal();
    if (!local || !isContextValid()) return;
    let stored;
    try {
      ({ [TOGGLES_KEY]: stored = {} } = await local.get(TOGGLES_KEY));
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        stop();
        return;
      }
      throw err;
    }
    const next = stored[FEATURE_ID] === true;
    if (next === enabled) return;
    enabled = next;
    if (enabled) start();
    else stop();
  }

  function watchToggleChanges() {
    const onChanged = globalThis.chrome?.storage?.onChanged;
    const browserChanged = globalThis.browser?.storage?.onChanged;
    const subscribe = onChanged ?? browserChanged;
    if (!subscribe) return;
    subscribe.addListener((changes, area) => {
      if (area === "local" && changes[TOGGLES_KEY]) void syncFromStorage();
    });
  }

  void syncFromStorage().catch(() => {});
  watchToggleChanges();
})();
