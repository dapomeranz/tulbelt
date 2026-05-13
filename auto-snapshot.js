// In the tulip.co app editor, count time the user is actively editing each
// app and, every 30 active minutes, drive the native snapshot flow:
// click the snapshot button, fill the description, click Create snapshot.
//
// "Active" means: tab visible, URL still on /apps/<id>/versions/..., and an
// input event seen in the last IDLE_AFTER_MS. Time is bucketed per app id so
// switching apps doesn't bleed counters together.

(() => {
const FEATURE_ID = 'auto-snapshot';
const TOGGLES_KEY = 'toggles';
const STATE_KEY = 'autoSnapshotState';
const URL_PATTERN =
  /^https?:\/\/([^.]+)\.tulip\.co\/apps\/([^/]+)\/versions(\/|$)/;
const ACTIVE_THRESHOLD_MS = 30 * 60 * 1000;
const IDLE_AFTER_MS = 60 * 1000;
const TICK_MS = 1000;
const PERSIST_EVERY_MS = 10 * 1000;
const ACTIVITY_EVENTS = [
  'mousemove',
  'mousedown',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
];

let enabled = false;
let currentAppId = null;
let lastActivityAt = 0;
let lastPersistAt = 0;
let activeMs = {}; // appId -> accumulated active milliseconds
let tickHandle = null;
let urlPollHandle = null;
let snapshotInProgress = false;

function getAppId(url = location.href) {
  const m = URL_PATTERN.exec(url);
  return m ? m[2] : null;
}

async function loadState() {
  const { [STATE_KEY]: stored = {} } =
    await chrome.storage.local.get(STATE_KEY);
  activeMs = stored;
}

// Re-read before writing so two tabs on different apps don't clobber each
// other's counters. Only this app's slot changes.
async function persistAppState(appId) {
  if (!appId) return;
  const { [STATE_KEY]: stored = {} } =
    await chrome.storage.local.get(STATE_KEY);
  stored[appId] = activeMs[appId] || 0;
  await chrome.storage.local.set({ [STATE_KEY]: stored });
}

function markActivity() {
  lastActivityAt = Date.now();
}

function isActive() {
  return (
    document.visibilityState === 'visible' &&
    Date.now() - lastActivityAt < IDLE_AFTER_MS
  );
}

function showOverlay(message) {
  let el = document.getElementById('tulbelt-snapshot-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'tulbelt-snapshot-overlay';
    el.style.cssText = [
      'position:fixed',
      'top:16px',
      'right:16px',
      'z-index:2147483647',
      'background:rgba(28,105,225,0.95)',
      'color:#fff',
      'padding:10px 14px',
      'border-radius:8px',
      'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,0.2)',
      'max-width:280px',
      'pointer-events:none',
    ].join(';');
    document.body.appendChild(el);
  }
  el.textContent = message;
  return el;
}

function hideOverlay() {
  document.getElementById('tulbelt-snapshot-overlay')?.remove();
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
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

async function performSnapshot(appId) {
  // Defer if another modal is already up — don't fight the user.
  if (document.querySelector('[data-testid="modal"]')) return false;
  const snapshotBtn = document.querySelector(
    '[data-testid="app-editor-snapshot"]'
  );
  if (!snapshotBtn) return false;

  const overlay = showOverlay('Tulbelt: capturing snapshot…');
  try {
    snapshotBtn.click();

    const textarea = await waitForElement(
      '[data-testid="version-description-input"]'
    );
    const minutes = Math.round((activeMs[appId] || 0) / 60000);
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
    setReactValue(
      textarea,
      `Tulbelt auto-snapshot after ${minutes} min of active editing — ${stamp} UTC`
    );

    const confirmBtn = await waitForElement(
      '[data-testid="publish-confirm"]'
    );
    // Brief pause so React processes the input event and enables submit.
    await new Promise((r) => setTimeout(r, 150));
    confirmBtn.click();

    overlay.textContent = 'Tulbelt: snapshot created.';
    setTimeout(hideOverlay, 2000);
    return true;
  } catch (err) {
    overlay.textContent = `Tulbelt: snapshot failed (${err.message}).`;
    setTimeout(hideOverlay, 4000);
    // Close any half-open modal so the next attempt starts clean.
    document
      .querySelector('[data-testid="close-modal-button"]')
      ?.click();
    return false;
  }
}

async function tick() {
  if (snapshotInProgress) return;
  if (!currentAppId) return;
  if (!isActive()) return;

  const prev = activeMs[currentAppId] || 0;
  const next = prev + TICK_MS;
  activeMs[currentAppId] = next;

  const now = Date.now();
  if (now - lastPersistAt >= PERSIST_EVERY_MS) {
    lastPersistAt = now;
    persistAppState(currentAppId);
  }

  if (next >= ACTIVE_THRESHOLD_MS) {
    snapshotInProgress = true;
    const appAtTrigger = currentAppId;
    try {
      const ok = await performSnapshot(appAtTrigger);
      if (ok) {
        activeMs[appAtTrigger] = 0;
        await persistAppState(appAtTrigger);
      }
      // On failure, leave the counter alone — the next tick retries once
      // whatever blocked us (open modal, missing button) clears.
    } finally {
      snapshotInProgress = false;
    }
  }
}

function checkUrl() {
  const newAppId = getAppId();
  if (newAppId !== currentAppId) {
    // Persist the outgoing app before switching so its time isn't lost.
    if (currentAppId) persistAppState(currentAppId);
    currentAppId = newAppId;
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
  await loadState();
  checkUrl();
  markActivity();
  startActivityListeners();
  tickHandle = setInterval(tick, TICK_MS);
  urlPollHandle = setInterval(checkUrl, 1000);
}

function stop() {
  if (tickHandle) clearInterval(tickHandle);
  if (urlPollHandle) clearInterval(urlPollHandle);
  tickHandle = null;
  urlPollHandle = null;
  stopActivityListeners();
  hideOverlay();
  if (currentAppId) persistAppState(currentAppId);
  currentAppId = null;
}

async function syncFromStorage() {
  const { [TOGGLES_KEY]: stored = {} } =
    await chrome.storage.local.get(TOGGLES_KEY);
  const next = stored[FEATURE_ID] ?? false;
  if (next === enabled) return;
  enabled = next;
  if (enabled) start();
  else stop();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[TOGGLES_KEY]) syncFromStorage();
});

syncFromStorage();
})();
