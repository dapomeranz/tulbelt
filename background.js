import { FEATURES, STORAGE_KEY, getToggles, ruleIdFor } from './features.js';

const TABLE_FEATURE_ID = 'table-default-sort';
const TABLE_URL_RE =
  /^https:\/\/([^/]+)\.tulip\.co((?:\/w\/[^/]+)?\/table\/[^?]+)$/;
const SORT_QUERY =
  'sortOptions=%5B%7B%22sortBy%22%3A%22_createdAt%22%2C%22sortDir%22%3A%22desc%22%7D%5D&offset=0';

async function syncRules() {
  const toggles = await getToggles();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules = FEATURES.flatMap((feature, i) => {
    if (!feature.rule || !toggles[feature.id]) return [];
    return [{ id: ruleIdFor(i), priority: 1, ...feature.rule }];
  });

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds,
    addRules,
  });
}

// declarativeNetRequest only fires on real network requests, so SPA
// navigations within Tulip (history.pushState) bypass it. Catch those here
// and trigger a real navigation to the sorted URL.
async function onSpaNavigation(details) {
  if (details.frameId !== 0) return;
  const toggles = await getToggles();
  if (!toggles[TABLE_FEATURE_ID]) return;
  const m = details.url.match(TABLE_URL_RE);
  if (!m) return;
  try {
    await chrome.tabs.update(details.tabId, {
      url: `https://${m[1]}.tulip.co${m[2]}?${SORT_QUERY}`,
    });
  } catch {
    // Tab may have closed or navigated again — ignore.
  }
}

chrome.runtime.onInstalled.addListener(syncRules);
chrome.runtime.onStartup.addListener(syncRules);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[STORAGE_KEY]) syncRules();
});
chrome.webNavigation.onHistoryStateUpdated.addListener(onSpaNavigation, {
  url: [{ hostSuffix: '.tulip.co', pathContains: '/table/' }],
});
